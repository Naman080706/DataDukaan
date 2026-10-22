"""What a validated SELECT actually computes: measure, period, grouping and exclusions.

Shared by the claim checker (does the answer describe what the SQL did?), the trap-suite failure
taxonomy (how does the agent's SQL differ from the reference?) and the correction memory.
"""
import re

import sqlglot
from sqlglot import exp

DATE_LIT = re.compile(r"'(\d{4})-(\d{2})-(\d{2})")
TIME_FUNCS = {"month": "month", "quarter": "quarter", "year": "year", "week": "week", "day": "day"}

# Plain-English names for each failure / correction category (also used by the UI).
CATEGORIES = {
    "wrong_metric": "Wrong metric definition",
    "wrong_period": "Wrong filter or period",
    "wrong_grouping": "Wrong grouping",
    "missing_exclusion": "Missing exclusion rule",
}


def _outer_select(stmt: exp.Expression) -> exp.Select | None:
    if isinstance(stmt, exp.Select):
        return stmt
    return next(iter(stmt.find_all(exp.Select)), None)


def _time_grain(node: exp.Expression) -> str | None:
    """month / quarter / year when an expression buckets invoice_date, else None."""
    text = node.sql(dialect="duckdb").lower()
    if "invoice_date" not in text:
        return None
    if "%y-%m" in text or "'month'" in text or re.search(r"\bmonth\(", text):
        return "month"
    if "quarter" in text:
        return "quarter"
    if re.search(r"\byear\(|'year'|%y'", text):
        return "year"
    if "'week'" in text:
        return "week"
    if "'day'" in text or "cast(invoice_date as date)" in text:
        return "day"
    return None


def _dimension(node: exp.Expression) -> str | None:
    grain = _time_grain(node)
    if grain:
        return grain
    cols = {c.name.lower() for c in node.find_all(exp.Column)} | (
        {node.name.lower()} if isinstance(node, exp.Column) else set())
    for col, dim in (("stock_code", "product"), ("description", "product"), ("country", "country"),
                     ("customer_id", "customer"), ("invoice", "invoice")):
        if col in cols:
            return dim
    return None


def _grouping(sel: exp.Select) -> list[str]:
    group = sel.args.get("group")
    if not group:
        return []
    projections = sel.expressions
    dims = []
    for g in group.expressions:
        target = g
        if isinstance(g, exp.Literal) and g.is_int and 0 < int(g.this) <= len(projections):
            target = projections[int(g.this) - 1]
        elif isinstance(g, exp.Column):
            # GROUP BY an alias: look the alias up among the projections.
            alias = next((p for p in projections if p.alias_or_name.lower() == g.name.lower() and isinstance(p, exp.Alias)), None)
            target = alias.this if alias is not None else g
        d = _dimension(target)
        if d and d not in dims:
            dims.append(d)
    return dims


def _line_types(sql_lower: str) -> set[str]:
    types = set()
    for m in re.finditer(r"line_type\s*(=|in)\s*(\([^)]*\)|'[^']*')", sql_lower):
        types |= set(re.findall(r"'([a-z_]+)'", m.group(2)))
    if re.search(r"\bis_cancelled\b(?!\s*=\s*false)", sql_lower) and not types:
        types.add("cancellation")
    return types


def _measure(sel: exp.Select, line_types: set[str]) -> str | None:
    """net / gross / units / returned_units / orders / return_invoices / customers / total_value."""
    aggs = [a for p in sel.expressions for a in p.find_all(exp.AggFunc)]
    for a in aggs:
        text = a.sql(dialect="duckdb").lower()
        if "line_value" in text and isinstance(a, exp.Sum):
            if not line_types:
                return "total_value"
            if line_types == {"sale"}:
                return "gross"
            if line_types == {"cancellation"}:
                return "return_value"
            if {"sale", "cancellation"} <= line_types:
                return "net"
        if "quantity" in text and isinstance(a, exp.Sum):
            if "-quantity" in text.replace(" ", "") or "abs(" in text or line_types == {"cancellation"}:
                return "returned_units"
            return "units"
        if isinstance(a, exp.Count) and "customer_id" in text:
            return "customers"
        if isinstance(a, exp.Count) and "invoice" in text:
            return "return_invoices" if line_types == {"cancellation"} else "orders"
    return None


def _period(sql_lower: str) -> tuple[str, str] | None:
    dates = sorted({f"{y}-{m}-{d}" for y, m, d in DATE_LIT.findall(sql_lower)})
    if not dates:
        return None
    return dates[0], dates[-1]


def facts(sql: str) -> dict:
    """Facts about a single SELECT. Never raises: unparseable SQL gives mostly-empty facts."""
    out = {"measure": None, "line_types": [], "period": None, "years": [], "grouping": [],
           "products_only": False, "known_customers_only": False, "countries": [], "excluded_countries": []}
    if not sql:
        return out
    low = sql.lower()
    try:
        stmt = sqlglot.parse_one(sql, read="duckdb")
    except sqlglot.errors.ParseError:
        stmt = None
    sel = _outer_select(stmt) if stmt is not None else None
    # The outer query's own filter decides the measure; inner WITH steps (e.g. "best month") may use another.
    where = sel.args.get("where") if sel is not None else None
    if where is not None:
        where = where.copy()
        for sub in list(where.find_all(exp.Subquery)):
            sub.replace(exp.null())
    types = _line_types(where.sql(dialect="duckdb").lower()) if where is not None else set()
    types = types or _line_types(low)
    out["line_types"] = sorted(types)
    if sel is not None:
        out["measure"] = _measure(sel, types)
        out["grouping"] = _grouping(sel)
    out["period"] = _period(low)
    if out["period"]:
        start, end = out["period"]
        last = int(end[:4]) - (1 if end[5:] == "01-01" else 0)
        out["years"] = list(range(int(start[:4]), max(last, int(start[:4])) + 1))
    out["products_only"] = bool(re.search(r"\bis_product\b(?!\s*=\s*false)", low))
    out["known_customers_only"] = bool(re.search(r"customer_id\s+is\s+not\s+null|\bhas_customer\b", low))
    out["countries"] = sorted(set(re.findall(r"country\s*=\s*'([^']+)'", sql, re.IGNORECASE)))
    out["excluded_countries"] = sorted(set(re.findall(r"country\s*(?:<>|!=)\s*'([^']+)'", sql, re.IGNORECASE)))
    return out


def diff(reference_sql: str, agent_sql: str) -> list[str]:
    """Which categories (CATEGORIES keys) separate the agent's SQL from the reference, most basic first."""
    ref, got = facts(reference_sql), facts(agent_sql)
    found = []
    if ref["measure"] != got["measure"] or ref["line_types"] != got["line_types"]:
        found.append("wrong_metric")
    if ref["period"] != got["period"] or ref["countries"] != got["countries"]:
        found.append("wrong_period")
    if ref["grouping"] != got["grouping"]:
        found.append("wrong_grouping")
    if (ref["products_only"] and not got["products_only"]) or (ref["known_customers_only"] and not got["known_customers_only"]) \
            or set(ref["excluded_countries"]) - set(got["excluded_countries"]):
        found.append("missing_exclusion")
    return found
