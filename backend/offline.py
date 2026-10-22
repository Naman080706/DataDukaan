"""Offline rule engine: answers common questions without any LLM.

Parses the question into measure / breakdown / period / filters and fills
pre-checked SQL templates that follow the rules in rules.py. When it is not sure
what a question means, it returns None (or asks back) instead of guessing.
"""
import re

from dataclasses import dataclass, field
from typing import Callable

from . import db
from .rules import DATASET_END, periods

YEAR_RE = r"(?:19|20)\d\d"


@dataclass
class Ctx:
    """What backup mode needs to know about the dataset it is answering for."""
    periods: dict
    countries: list[str] | None = None            # None = read them from the built-in database
    execute: Callable[[str], dict] | None = None  # runs SQL for step-1 lookups; None when the data lives in the browser
    notes: list[str] = field(default_factory=list)


BUILTIN = Ctx(periods=periods(DATASET_END), execute=db.execute_readonly_sql)

# measure -> (select expression, alias, base filter, plain-English label)
MEASURES = {
    "net": ("ROUND(SUM(line_value), 2)", "net_revenue_gbp", "line_type IN ('sale', 'cancellation')", "net revenue (sales minus returns)"),
    "gross": ("ROUND(SUM(line_value), 2)", "gross_revenue_gbp", "line_type = 'sale'", "revenue excluding cancelled invoices"),
    "units": ("SUM(quantity)", "units_sold", "line_type = 'sale'", "units sold"),
    "orders": ("COUNT(DISTINCT invoice)", "orders", "line_type = 'sale'", "orders (distinct sale invoices)"),
    "returned_units": ("SUM(-quantity)", "returned_units", "line_type = 'cancellation'", "units returned"),
    "return_invoices": ("COUNT(DISTINCT invoice)", "return_invoices", "line_type = 'cancellation'", "return invoices"),
    "cancelled": ("COUNT(DISTINCT invoice)", "cancelled_invoices", "is_cancelled", "cancelled invoices"),
    "customers": ("COUNT(DISTINCT customer_id)", "customers", "line_type = 'sale' AND customer_id IS NOT NULL", "unique customers"),
}

# breakdown -> (select, group by, extra filter, is time series)
DIMENSIONS = {
    "product": ("stock_code, any_value(description) AS description", "stock_code", "is_product", False),
    "country": ("country", "country", None, False),
    "customer": ("customer_id", "customer_id", "customer_id IS NOT NULL", False),
    "month": ("strftime(invoice_date, '%Y-%m') AS month", "1", None, True),
    "quarter": ("concat(year(invoice_date), '-Q', quarter(invoice_date)) AS quarter", "1", None, True),
    "year": ("year(invoice_date) AS year", "1", None, True),
}

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
WRITE_WORDS = re.compile(r"\b(delete|drop|update|insert|truncate|alter|remove|modify|overwrite)\b")
# Time phrases the engine does not define; it declines rather than answer for the wrong period.
UNSUPPORTED_TIME = re.compile(r"\b(this month|this quarter|yesterday|today|last week|this week|ytd)\b")
METRIC_WORDS = re.compile(r"\b(revenue|sales|sold|spend|spent|turnover|value|units|quantity|orders|invoices|purchases|returned|returns)\b")

_countries: list[str] | None = None


def _known_countries() -> list[str]:
    global _countries
    if _countries is None:
        rows = db.execute_readonly_sql("SELECT DISTINCT country FROM transactions WHERE country IS NOT NULL")["rows"]
        _countries = sorted((r[0] for r in rows), key=len, reverse=True)
    return _countries


def _norm(q: str) -> str:
    return re.sub(r"\s+", " ", q.lower().replace("’", "'")).strip()


def _merge_followup(question: str, history: list[dict]) -> str:
    """'now only for Germany' / 'by net revenue' inherit the previous question."""
    q = _norm(question)
    prev = next((t["content"] for t in reversed(history or []) if t.get("role") == "user"), None)
    if not prev:
        return q
    names_period = re.match(r"^(q[1-4]\s+20\d\d|(" + "|".join(MONTHS) + r")\s+20\d\d)\b", q)  # a picked quarter/month option
    is_followup = re.match(r"^(by|only|now|and|what about|how about|same|just|for|in)\b", q) or names_period or (
        not METRIC_WORDS.search(q) and not re.search(r"\b(product|country|countries|customer|month|quarter|year)", q)
    )
    return f"{_norm(prev)} {q}" if is_followup else q


def _clarify(question: str, options: list[str]) -> dict:
    return {"action": "clarify", "question": question, "options": options}



# --- Multi-step questions: "top products in the best month of 2011", "in the country with the highest revenue
# outside the UK, ...", "which month had the most returns, and what were the most returned products that month?".
# The inner question is answered first (shown to the user), then used as a filter on the main question.
_SUP_HIGH = {"best", "top", "highest", "biggest", "strongest", "most", "largest"}
_XUK = r"(?P<xuk>\s+(?:outside|excluding|other than|apart from)\s+(?:the\s+)?(?:uk|united kingdom))?"
_YEAR = r"(?:\s+(?:of|in|for)\s+(?:the\s+year\s+)?(?P<year>" + YEAR_RE + "))?"
_NESTED = [
    re.compile(r"\b(?:in|for|during|from|of)\s+(?:the\s+)?(?P<sup>best|top|highest|biggest|strongest|worst|lowest|weakest)"
               r"(?:[\s-]+(?:selling|sales|revenue|performing))?\s+(?P<kind>month|quarter|country)\b" + _YEAR + _XUK),
    re.compile(r"\b(?:in|for|during|from)\s+the\s+(?P<kind>month|quarter|country)\s+(?:of\s+(?P<year0>" + YEAR_RE + r")\s+)?"
               r"with\s+the\s+(?P<sup>highest|most|biggest|largest|lowest|least|fewest)\s+"
               r"(?P<what>net revenue|revenue|sales|returns|returned units|orders)" + _XUK + _YEAR),
]
_TWO_CLAUSE = re.compile(
    r"^(?:which|what)\s+(?P<kind>month|quarter|country)\s+(?:(?:of|in)\s+)?(?:(?P<year>" + YEAR_RE + r")\s+)?"
    r"(?:had|saw|got|has|did)\s+(?:the\s+)?(?P<sup>most|highest|biggest|fewest|least|lowest|best|worst)\s+"
    r"(?P<what>returns|returned units|net revenue|revenue|sales|orders)\b.*?(?:,\s*and|\s+and|,)\s+(?P<rest>.+)$")
_KIND = {
    "month": ("date_trunc('month', invoice_date)", "strftime(k, '%Y-%m')"),
    "quarter": ("date_trunc('quarter', invoice_date)", "concat(year(k), '-Q', quarter(k))"),
    "country": ("country", "k"),
}


def _extract_pick(q: str, ctx: Ctx) -> tuple[str, dict | None]:
    """Find an inner "best/worst month|quarter|country" step; return the question without it, and the step."""
    m = _TWO_CLAUSE.match(q)
    rest = None
    if m:
        rest = re.sub(r"\b(?:in\s+|for\s+|during\s+)?that\s+(?:month|quarter|country)\b", "", m.group("rest")).strip()
    else:
        m = next((x for p in _NESTED for x in [p.search(q)] if x), None)
        if not m:
            return q, None
    g = m.groupdict()
    kind, sup, what = g["kind"], g["sup"], (g.get("what") or "net revenue")
    year = g.get("year") or g.get("year0")
    remaining = rest if rest is not None else (q[:m.start()] + " " + q[m.end():])
    if not year:
        years = re.findall(r"\b(" + YEAR_RE + r")\b", q)
        year = years[-1] if years else None
    if "return" in what:
        expr, base, measure_label = "SUM(-quantity)", "line_type = 'cancellation'", "units returned"
    elif what == "orders":
        expr, base, measure_label = "COUNT(DISTINCT invoice)", "line_type = 'sale'", "orders"
    else:
        expr, base, measure_label = "SUM(line_value)", "line_type IN ('sale', 'cancellation')", "net revenue"
    where = [base]
    if year:
        where.append(f"invoice_date >= '{year}-01-01' AND invoice_date < '{int(year) + 1}-01-01'")
    if g.get("xuk"):
        where.append("country <> 'United Kingdom'")
    key, label = _KIND[kind]
    direction = "DESC" if sup in _SUP_HIGH else "ASC"
    inner = f"SELECT {key} AS k FROM transactions WHERE {' AND '.join(where)} GROUP BY 1 ORDER BY {expr} {direction} LIMIT 1"
    word = "highest" if direction == "DESC" else "lowest"
    scope = f" of {year}" if year else ""
    scope += " outside the UK" if g.get("xuk") else ""
    if ctx.execute is None:
        # The data is in the user's browser: the step-1 answer appears as a column in the result instead.
        return remaining, {
            "kind": kind, "key": key, "label": label, "inner": inner, "year": year, "value": "",
            "column": f"{'best' if direction == 'DESC' else 'worst'}_{kind}",
            "step1": f"Find the {kind}{scope} with the {word} {measure_label}.",
            "title": f" in the {kind} with the {word} {measure_label}",
        }
    picked = ctx.execute(f"SELECT {label} AS v FROM ({inner})")["rows"]
    value = picked[0][0] if picked else None
    shown = value
    if kind == "month" and value:
        y, mo = str(value).split("-")
        shown = f"{list(MONTHS)[int(mo) - 1].title()} {y}"
    return remaining, {
        "kind": kind, "key": key, "label": label, "inner": inner, "year": year, "value": value,
        "column": f"{'best' if direction == 'DESC' else 'worst'}_{kind}",
        "step1": f"The {kind}{scope} with the {word} {measure_label} was {shown}.",
        "title": f" in {shown}",
    }


def plan_offline(question: str, history: list[dict] | None = None, ctx: Ctx | None = None,
                 overrides: dict | None = None) -> dict | None:
    """Return a planner-shaped dict (action sql/clarify/refuse) or None if not understood.

    ctx describes the dataset (built-in by default, or a user's own file); overrides come from the user's past
    corrections (backend/memory.py): {"measure", "dim", "period", "exclude"}.
    """
    ctx = ctx or BUILTIN
    per = ctx.periods
    ty, ly, end_label = per["this_year"], per["last_year"], per["end_label"]
    q = _merge_followup(question, history or [])
    ov = overrides or {}

    if WRITE_WORDS.search(q):
        return {"action": "refuse", "reason": "I can only read the sales data. Changing or deleting records isn't allowed."}
    if re.search(r"\bhow are we doing\b|\bperformance\b|\boverview\b|\bsummary\b", q) and not METRIC_WORDS.search(q):
        return _clarify("What would you like to look at?", [
            f"Net revenue by month in {ty}", "Top 10 products by net revenue", f"Returned units by month in {ty}"])
    if UNSUPPORTED_TIME.search(q):
        return None

    assumptions: list[str] = []
    filters: list[str] = []
    period_label = ""

    # "This year" / "last year" are relative to the end of the data, not today.
    if re.search(r"\bthis year\b", q):
        q = re.sub(r"\bthis year\b", str(ty), q)
        assumptions.append(f"This year means {ty}, the latest year in the data; it ends on {end_label}.")
    if re.search(r"\blast year\b", q):
        q = re.sub(r"\blast year\b", str(ly), q)
        assumptions.append(f"Last year means {ly}, the year before the latest year in the data.")

    q, pick = _extract_pick(q, ctx)
    if pick:
        if pick["value"] is None:
            return None
        assumptions.append(f"Step 1: {pick['step1']} Step 2 uses only that {pick['kind']}.")
        filters.append(f"{pick['key']} = (SELECT k FROM pick)")
        if pick["kind"] == "country" and pick["year"] and not re.search(r"\b" + YEAR_RE + r"\b", q):
            q += f" {pick['year']}"

    # Period: an explicit quarter/month/year wins; the last mention wins, so follow-ups can override.
    mq = re.findall(r"\bq([1-4])\s*(?:of\s*)?(" + YEAR_RE + r")\b", q)
    mm = re.findall(r"\b(" + "|".join(MONTHS) + r")\s+(" + YEAR_RE + r")\b", q)
    my = re.findall(r"\b(" + YEAR_RE + r")\b", q)
    # If the data stops part-way through a quarter/month, relative periods are ambiguous: ask which one.
    if re.search(r"\b(last|previous) quarter\b", q) and not mq and not ov.get("period"):
        if len(per["quarter_options"]) > 1:
            return _clarify(f"Which quarter do you mean? The data ends on {end_label}.", per["quarter_options"])
        q = re.sub(r"\b(last|previous) quarter\b", per["quarter_options"][0].split(" (")[0].lower(), q)
        mq = re.findall(r"\bq([1-4])\s*(?:of\s*)?(" + YEAR_RE + r")\b", q)
    if re.search(r"\b(last|previous) month\b", q) and not mm and not ov.get("period"):
        if len(per["month_options"]) > 1:
            return _clarify(f"Which month do you mean? The data ends on {end_label}.", per["month_options"])
        q = re.sub(r"\b(last|previous) month\b", per["month_options"][0].split(" (")[0].lower(), q)
        mm = re.findall(r"\b(" + "|".join(MONTHS) + r")\s+(" + YEAR_RE + r")\b", q)
    period_at = len(filters)
    if mq:
        n, y = int(mq[-1][0]), int(mq[-1][1])
        start, end = f"{y}-{3 * n - 2:02d}-01", (f"{y}-{3 * n + 1:02d}-01" if n < 4 else f"{y + 1}-01-01")
        filters.append(f"invoice_date >= '{start}' AND invoice_date < '{end}'")
        period_label = f" in Q{n} {y}"
        if per["partial_quarter"] and start == per["partial_quarter"][0]:
            assumptions.append(f"Q{n} {y} is incomplete: the data ends on {end_label}.")
    elif mm:
        m, y = MONTHS[mm[-1][0]], int(mm[-1][1])
        end = f"{y}-{m + 1:02d}-01" if m < 12 else f"{y + 1}-01-01"
        filters.append(f"invoice_date >= '{y}-{m:02d}-01' AND invoice_date < '{end}'")
        period_label = f" in {mm[-1][0].title()} {y}"
    elif my:
        y = int(my[-1])
        filters.append(f"invoice_date >= '{y}-01-01' AND invoice_date < '{y + 1}-01-01'")
        period_label = f" in {y}"
        if y == ty and not end_label.startswith("31 Dec"):
            assumptions.append(f"{ty} data ends on {end_label}.")

    if ov.get("period"):  # a period the user taught replaces the one read from the question
        p = ov["period"]
        del filters[period_at:]
        filters.append(f"invoice_date >= '{p['start']}' AND invoice_date < '{p['end']}'")
        period_label = f" in {p['label']}"
        assumptions = [a for a in assumptions
                       if not a.startswith(("This year means", "Last year means")) and "data ends on" not in a]

    country = next((c for c in (ctx.countries if ctx.countries is not None else _known_countries()) if re.search(r"\b" + re.escape(c.lower()) + r"\b", q)), None)
    if country:
        filters.append(f"country = '{country}'")
    exclusions = {"uk": "country <> 'United Kingdom'", "non_products": "is_product", "unknown_customers": "customer_id IS NOT NULL"}
    filters += [exclusions[x] for x in ov.get("exclude", []) if x in exclusions]

    # Special cases with their own SQL.
    if "total transaction value" in q:
        sql = ("SELECT ROUND(SUM(line_value), 2) AS total_transaction_value_gbp, "
               "ROUND(SUM(line_value) FILTER (WHERE line_type IN ('sale', 'cancellation')), 2) AS net_sales_value_gbp "
               "FROM transactions" + (" WHERE " + " AND ".join(filters) if filters else ""))
        assumptions.append("Total transaction value adds up everything in the records, including stock write-offs and bad-debt entries; "
                           "net sales value is sales minus returns.")
        return {"action": "sql", "sql": sql, "assumptions": assumptions, "title": "Total transaction value vs net sales value"}

    # Breakdown. "Which month was best?" ranks months; it isn't a total for the year.
    rank_period = re.search(r"\b(?:which|what)\b.*?\b(month|quarter|year)\b|\b(?:best|top|highest|biggest|strongest|worst|lowest|weakest)"
                            r"(?:[\s-]+(?:selling|sales|revenue|performing))?\s+(month|quarter|year)\b", q)
    rank_dim = (rank_period.group(1) or rank_period.group(2)) if rank_period and re.search(
        r"\b(best|top|highest|biggest|strongest|most|worst|lowest|weakest|least|fewest)\b", q) else None
    dim = None
    if re.search(r"\b(monthly|by month|per month|each month|month by month|trend)\b", q):
        dim = "month"
    elif re.search(r"\b(quarterly|by quarter|per quarter|each quarter)\b", q):
        dim = "quarter"
    elif re.search(r"\b(yearly|annual|by year|per year|each year)\b", q):
        dim = "year"
    elif re.search(r"\b(products?|items?|stock codes?|skus?)\b", q):
        dim = "product"
    elif re.search(r"\b(country|countries|markets?)\b", q) and not country:
        dim = "country"
    elif re.search(r"\bcustomers?\b", q) and not re.search(r"\bhow many\b|\bnumber of\b|\bcount\b", q):
        dim = "customer"
    elif rank_dim:  # only when the question isn't already about products, countries or customers
        dim = rank_dim
    if ov.get("dim"):
        dim = None if ov["dim"] == "none" else ov["dim"]

    # Measure.
    measure = None
    if re.search(r"\bhow many\b|\bnumber of\b|\bcount\b", q) and not dim:
        if "cancel" in q:
            measure = "cancelled"
        elif "customer" in q:
            measure = "customers"
        elif re.search(r"\breturn", q):
            measure = "return_invoices"
        elif re.search(r"\b(orders|invoices|purchases)\b", q):
            measure = "orders"
        elif re.search(r"\b(units|items|products)\b", q):
            measure = "units"
    if measure is None:
        if re.search(r"\breturn", q):
            measure = "return_invoices" if re.search(r"\b(often|frequent|frequently|times)\b", q) else "returned_units"
        elif re.search(r"exclud\w* cancel|without cancel|gross", q):
            measure = "gross"
        elif re.search(r"\b(units|quantity|volume|sold most|most sold|best.?selling)\b", q):
            measure = "units"
        elif re.search(r"\b(orders|invoices|purchases)\b", q):
            measure = "orders"
        elif re.search(r"\b(revenue|sales|turnover|spend|spent|value|earned|generated|money|income)\b", q):
            measure = "net"
        elif re.search(r"\bcancel", q):
            measure = "cancelled"

    if ov.get("measure") in MEASURES:
        measure = ov["measure"]
    if measure is None:
        if dim == "customer" and re.search(r"\b(best|top|biggest|largest|most valuable|key)\b", q):
            return _clarify("How should I rank customers?", ["By net revenue", "By number of orders", "By units bought"])
        if dim == "product" and re.search(r"\b(best|top|biggest|leading|popular)\b", q):
            return _clarify("How should I rank products?", ["By net revenue", "By units sold"])
        return None

    expr, alias, base, label = MEASURES[measure]
    where = [base] + filters
    if measure in ("returned_units", "return_invoices"):
        assumptions.append("Returns are items on cancellation invoices (invoice numbers starting with C).")
    if measure == "net":
        assumptions.append("Net revenue is sales minus returns.")
    if measure == "gross":
        assumptions.append("Only sales are counted; cancelled orders, stock write-offs and free items are left out.")

    if dim is None:
        sql = f"SELECT {expr} AS {alias} FROM transactions WHERE {' AND '.join(where)}"
        title = f"{label[0].upper()}{label[1:]}{period_label}{' for ' + country if country else ''}"
        return _with_pick({"action": "sql", "sql": sql, "assumptions": assumptions, "title": title}, pick)

    sel, group, dim_filter, is_time = DIMENSIONS[dim]
    if dim_filter:
        where.append(dim_filter)
    if dim == "product":
        assumptions.append("Postage, fees and manual adjustments are left out of product rankings.")
    if dim == "customer":
        assumptions.append("Sales without a customer ID are left out of customer rankings.")

    if is_time and dim != rank_dim:
        order, limit = "1 ASC", 200
    elif is_time:  # "which month was best": every period, best (or worst) first
        worst_first = re.search(r"\b(least|lowest|fewest|worst|weakest)\b", q)
        order, limit = f"{alias} {'ASC' if worst_first else 'DESC'}", 200
    else:
        m = re.search(r"\b(?:top|bottom|first)\s+(\d{1,3})\b", q)
        limit = min(int(m.group(1)), 200) if m else 10
        direction = "ASC" if re.search(r"\b(least|lowest|fewest|bottom|worst)\b", q) else "DESC"
        order = f"{alias} {direction}"
    sql = (f"SELECT {sel}, {expr} AS {alias} FROM transactions WHERE {' AND '.join(where)} "
           f"GROUP BY {group} ORDER BY {order} LIMIT {limit}")
    title = f"{label[0].upper()}{label[1:]} by {dim}{period_label}{' for ' + country if country else ''}"
    return _with_pick({"action": "sql", "sql": sql, "assumptions": assumptions, "title": title}, pick)


def _with_pick(plan: dict, pick: dict | None) -> dict:
    """Put the inner step in front of the main query as a WITH step, and show which month/country it chose."""
    if not pick:
        return plan
    sql = plan["sql"].replace("SELECT ", f"SELECT (SELECT {pick['label']} FROM pick) AS {pick['column']}, ", 1)
    plan["sql"] = f"WITH pick AS ({pick['inner']}) {sql}"
    plan["title"] += pick["title"]
    plan["steps"] = [pick["step1"], "Answer the main question within it"]
    return plan


def _fmt(col: str, v) -> str:
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if col.endswith("_gbp"):
            return f"£{v:,.2f}"
        return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"
    return str(v)


def describe_result(title: str, columns: list[str], rows: list[list]) -> str:
    """Plain-English answer built only from the returned rows (no LLM)."""
    if not rows:
        return f"{title}: the query returned no rows."
    if len(rows) == 1:
        parts = [f"{c.replace('_', ' ').replace(' gbp', '')} {_fmt(c, v)}" for c, v in zip(columns, rows[0])]
        return f"{title}: " + ", ".join(parts) + "."
    vi = next((i for i in range(len(columns) - 1, 0, -1) if isinstance(rows[0][i], (int, float))), len(columns) - 1)
    # Label each row by its description, else by the first column that isn't a constant "best_month"-style step result.
    li = columns.index("description") if "description" in columns else next(
        (i for i, c in enumerate(columns) if not c.startswith(("best_", "worst_"))), 0)
    name = lambda r: str(r[li] if r[li] is not None else r[0])  # noqa: E731
    if columns[0] in ("month", "quarter", "year"):
        hi = max(rows, key=lambda r: r[vi] or 0)
        lo = min(rows, key=lambda r: r[vi] or 0)
        return (f"{title}: {len(rows)} periods. Highest was {name(hi)} at {_fmt(columns[vi], hi[vi])}, "
                f"lowest was {name(lo)} at {_fmt(columns[vi], lo[vi])}.")
    top = "; ".join(f"{name(r)} ({_fmt(columns[vi], r[vi])})" for r in rows[:3])
    return f"{title}. Top of the list: {top}."
