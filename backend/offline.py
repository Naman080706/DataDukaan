"""Offline rule engine: answers common questions without any LLM.

Parses the question into measure / breakdown / period / filters and fills
pre-checked SQL templates that follow the rules in rules.py. When it is not sure
what a question means, it returns None (or asks back) instead of guessing.
"""
import re

from . import db
from .rules import LAST_FULL_QUARTER

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
UNSUPPORTED_TIME = re.compile(r"\b(last year|this year|this month|this quarter|yesterday|today|last week|this week|ytd)\b")
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
    is_followup = re.match(r"^(by|only|now|and|what about|how about|same|just|for|in)\b", q) or (
        not METRIC_WORDS.search(q) and not re.search(r"\b(product|country|countries|customer|month|quarter|year)", q)
    )
    return f"{_norm(prev)} {q}" if is_followup else q


def _clarify(question: str, options: list[str]) -> dict:
    return {"action": "clarify", "question": question, "options": options}


def plan_offline(question: str, history: list[dict] | None = None) -> dict | None:
    """Return a planner-shaped dict (action sql/clarify/refuse) or None if not understood."""
    q = _merge_followup(question, history or [])

    if WRITE_WORDS.search(q):
        return {"action": "refuse", "reason": "I can only read the sales data. Changing or deleting records isn't allowed."}
    if re.search(r"\bhow are we doing\b|\bperformance\b|\boverview\b|\bsummary\b", q) and not METRIC_WORDS.search(q):
        return _clarify("What would you like to look at?", [
            "Net revenue by month in 2011", "Top 10 products by net revenue", "Returned units by month in 2011"])
    if UNSUPPORTED_TIME.search(q):
        return None

    assumptions: list[str] = []
    filters: list[str] = []
    period_label = ""

    # Period: the last mention wins, so follow-ups like "... in 2010" override.
    if "last quarter" in q:
        filters.append(f"invoice_date >= '{LAST_FULL_QUARTER[0]}' AND invoice_date < '{LAST_FULL_QUARTER[1]}'")
        period_label = " in Q3 2011"
        assumptions.append("“Last quarter” is the last complete quarter in the data: Q3 2011 (Jul to Sep).")
    elif "last month" in q:
        filters.append("invoice_date >= '2011-11-01' AND invoice_date < '2011-12-01'")
        period_label = " in November 2011"
        assumptions.append("“Last month” is the last complete month in the data: November 2011.")
    else:
        mq = re.findall(r"\bq([1-4])\s*(?:of\s*)?(2009|2010|2011)\b", q)
        mm = re.findall(r"\b(" + "|".join(MONTHS) + r")\s+(2009|2010|2011)\b", q)
        my = re.findall(r"\b(2009|2010|2011)\b", q)
        if mq:
            n, y = int(mq[-1][0]), int(mq[-1][1])
            start, end = f"{y}-{3 * n - 2:02d}-01", (f"{y}-{3 * n + 1:02d}-01" if n < 4 else f"{y + 1}-01-01")
            filters.append(f"invoice_date >= '{start}' AND invoice_date < '{end}'")
            period_label = f" in Q{n} {y}"
        elif mm:
            m, y = MONTHS[mm[-1][0]], int(mm[-1][1])
            end = f"{y}-{m + 1:02d}-01" if m < 12 else f"{y + 1}-01-01"
            filters.append(f"invoice_date >= '{y}-{m:02d}-01' AND invoice_date < '{end}'")
            period_label = f" in {mm[-1][0].title()} {y}"
        elif my:
            y = int(my[-1])
            filters.append(f"invoice_date >= '{y}-01-01' AND invoice_date < '{y + 1}-01-01'")
            period_label = f" in {y}"
            if y == 2011:
                assumptions.append("2011 data ends on 9 December 2011.")

    country = next((c for c in _known_countries() if re.search(r"\b" + re.escape(c.lower()) + r"\b", q)), None)
    if country:
        filters.append(f"country = '{country}'")

    # Special cases with their own SQL.
    if "total transaction value" in q:
        sql = ("SELECT ROUND(SUM(line_value), 2) AS total_transaction_value_gbp, "
               "ROUND(SUM(line_value) FILTER (WHERE line_type IN ('sale', 'cancellation')), 2) AS net_sales_value_gbp "
               "FROM transactions" + (" WHERE " + " AND ".join(filters) if filters else ""))
        assumptions.append("Total transaction value adds up every line, including stock adjustments and bad-debt entries; "
                           "net sales value is sales minus returns.")
        return {"action": "sql", "sql": sql, "assumptions": assumptions, "title": "Total transaction value vs net sales value"}

    # Breakdown.
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

    if measure is None:
        if dim == "customer" and re.search(r"\b(best|top|biggest|largest|most valuable|key)\b", q):
            return _clarify("How should I rank customers?", ["By net revenue", "By number of orders", "By units bought"])
        if dim == "product" and re.search(r"\b(best|top|biggest|leading|popular)\b", q):
            return _clarify("How should I rank products?", ["By net revenue", "By units sold"])
        return None

    expr, alias, base, label = MEASURES[measure]
    where = [base] + filters
    if measure in ("returned_units", "return_invoices"):
        assumptions.append("Returns are lines on cancellation invoices (numbers starting with C).")
    if measure == "net":
        assumptions.append("Net revenue is sales minus returns; cancellation lines count as negative.")
    if measure == "gross":
        assumptions.append("Only sale lines are counted; cancelled invoices, stock adjustments and £0 lines are left out.")

    if dim is None:
        sql = f"SELECT {expr} AS {alias} FROM transactions WHERE {' AND '.join(where)}"
        title = f"{label[0].upper()}{label[1:]}{period_label}{' for ' + country if country else ''}"
        return {"action": "sql", "sql": sql, "assumptions": assumptions, "title": title}

    sel, group, dim_filter, is_time = DIMENSIONS[dim]
    if dim_filter:
        where.append(dim_filter)
    if dim == "product":
        assumptions.append("Postage, fees, manual adjustments and other non-product codes are left out of product rankings.")
    if dim == "customer":
        assumptions.append("Lines without a customer ID are left out of customer rankings.")

    if is_time:
        order, limit = "1 ASC", 200
    else:
        m = re.search(r"\b(?:top|bottom|first)\s+(\d{1,3})\b", q)
        limit = min(int(m.group(1)), 200) if m else 10
        direction = "ASC" if re.search(r"\b(least|lowest|fewest|bottom|worst)\b", q) else "DESC"
        order = f"{alias} {direction}"
    sql = (f"SELECT {sel}, {expr} AS {alias} FROM transactions WHERE {' AND '.join(where)} "
           f"GROUP BY {group} ORDER BY {order} LIMIT {limit}")
    title = f"{label[0].upper()}{label[1:]} by {dim}{period_label}{' for ' + country if country else ''}"
    return {"action": "sql", "sql": sql, "assumptions": assumptions, "title": title}


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
    li = columns.index("description") if "description" in columns else 0
    name = lambda r: str(r[li] if r[li] is not None else r[0])  # noqa: E731
    if columns[0] in ("month", "quarter", "year"):
        hi = max(rows, key=lambda r: r[vi] or 0)
        lo = min(rows, key=lambda r: r[vi] or 0)
        return (f"{title}: {len(rows)} periods. Highest was {name(hi)} at {_fmt(columns[vi], hi[vi])}, "
                f"lowest was {name(lo)} at {_fmt(columns[vi], lo[vi])}.")
    top = "; ".join(f"{name(r)} ({_fmt(columns[vi], r[vi])})" for r in rows[:3])
    return f"{title}. Top of the list: {top}."
