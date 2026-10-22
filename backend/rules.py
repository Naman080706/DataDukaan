"""Single source of truth for the retail data rules.

Used by ingestion (flag columns), the LLM prompt (so generated SQL follows the
same definitions) and the trap-suite reference SQL. retail_rules() builds the same
rules for any date range, so a user's own retail upload gets them too.
"""
from datetime import date, timedelta

# Stock codes that are not physical products (postage, fees, manual adjustments...).
NON_PRODUCT_CODES = [
    "POST", "DOT", "M", "MANUAL", "BANK CHARGES", "PADS", "C2", "C3", "CRUK",
    "D", "AMAZONFEE", "S", "B", "SP1002",
]
NON_PRODUCT_CODES_SQL = ", ".join(f"'{c}'" for c in NON_PRODUCT_CODES)

DATASET_START = "2009-12-01"
DATASET_END = "2011-12-09"

_MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    return date(d.year + m // 12, m % 12 + 1, 1)


def _fmt(d: date) -> str:
    return f"{d.day} {_MONTH[d.month - 1][:3]} {d.year}"


def periods(end: str) -> dict:
    """Last complete quarter/month before the end of the data, and the partial one it ends in (if any)."""
    e = date.fromisoformat(end[:10])
    q_start = date(e.year, 3 * ((e.month - 1) // 3) + 1, 1)
    q_end = _add_months(q_start, 3)
    m_start = date(e.year, e.month, 1)
    m_end = _add_months(m_start, 1)
    q_partial = e + timedelta(days=1) < q_end
    m_partial = e + timedelta(days=1) < m_end
    full_q = _add_months(q_start, -3) if q_partial else q_start
    full_m = _add_months(m_start, -1) if m_partial else m_start
    qn = lambda d: (d.month - 1) // 3 + 1  # noqa: E731
    months = lambda d: f"{_MONTH[d.month - 1][:3]} to {_MONTH[_add_months(d, 2).month - 1][:3]}"  # noqa: E731
    return {
        "end_date": e, "this_year": e.year, "last_year": e.year - 1,
        "full_quarter": (full_q.isoformat(), _add_months(full_q, 3).isoformat()),
        "full_quarter_label": f"Q{qn(full_q)} {full_q.year}",
        "partial_quarter": (q_start.isoformat(), q_end.isoformat()) if q_partial else None,
        "quarter_options": [f"Q{qn(full_q)} {full_q.year} ({months(full_q)}, the last complete quarter)"]
        + ([f"Q{qn(q_start)} {q_start.year} so far ({_fmt(q_start)[:-5]} to {_fmt(e)[:-5]})"] if q_partial else []),
        "full_month": (full_m.isoformat(), _add_months(full_m, 1).isoformat()),
        "partial_month": (m_start.isoformat(), m_end.isoformat()) if m_partial else None,
        "month_options": [f"{_MONTH[full_m.month - 1]} {full_m.year} (the last complete month)"]
        + ([f"{_MONTH[m_start.month - 1]} {m_start.year} so far ({m_start.day} to {e.day} {_MONTH[e.month - 1][:3]})"]
           if m_partial else []),
        "end_label": _fmt(e),
    }


def retail_rules(start: str, end: str, money: str = "GBP (pounds sterling)", money_suffix: str = "gbp",
                 source: str = "UCI Online Retail II") -> dict:
    """Schema doc, data rules and ambiguity rules for a `transactions` table covering start..end."""
    p = periods(end)
    fq, ty, ly = p["full_quarter"], p["this_year"], p["last_year"]
    ask_quarter = len(p["quarter_options"]) > 1
    ask_month = len(p["month_options"]) > 1
    sfx = money_suffix
    schema = f"""
Table: transactions  (one row per invoice line, {source}, {start[:10]} to {end[:10]})
  invoice        VARCHAR   invoice / order number; starts with 'C' = cancellation/credit note, 'A' = bad-debt adjustment
  stock_code     VARCHAR   product code (some codes are not products, see is_product)
  description    VARCHAR   product description (may be NULL)
  quantity       INTEGER   units; negative on cancellations/returns and stock adjustments
  invoice_date   TIMESTAMP date and time of the invoice
  price          DOUBLE    unit price in {money}
  customer_id    VARCHAR   customer id, NULL when unknown
  country        VARCHAR   customer country (may be NULL)
  line_value     DOUBLE    quantity * price in {money} (negative on cancellations/returns)
  is_cancelled   BOOLEAN   the line is a cancellation or return
  is_negative_qty BOOLEAN  quantity < 0
  has_customer   BOOLEAN   customer_id IS NOT NULL
  is_product     BOOLEAN   FALSE for postage, fees, manual adjustments, bank charges, samples, test codes
  line_type      VARCHAR   one of: 'sale', 'cancellation', 'stock_adjustment', 'zero_price', 'bad_debt_adjustment'
""".strip()

    if ask_quarter:
        relative = f"""    Relative periods ("last quarter", "last month") are relative to the end of the data ({p['end_label']}), NOT today,
    and are ambiguous because the data stops part-way through a quarter: ask which one is meant (see below).
    {p['full_quarter_label']} = invoice_date >= '{fq[0]}' AND invoice_date < '{fq[1]}';
    the partial quarter = invoice_date >= '{p['partial_quarter'][0]}' AND invoice_date < '{p['partial_quarter'][1]}'."""
    else:
        relative = f"""    Relative periods are relative to the end of the data ({p['end_label']}), NOT today.
    "Last quarter" = {p['full_quarter_label']} = invoice_date >= '{fq[0]}' AND invoice_date < '{fq[1]}'; state it."""
    fm = p["full_month"]
    relative += f"""
    The last complete month = invoice_date >= '{fm[0]}' AND invoice_date < '{fm[1]}'"""
    if p["partial_month"]:
        relative += f"""; the partial last month = '{p['partial_month'][0]}' to '{p['partial_month'][1]}'."""

    rules = f"""
DATA RULES (apply to every query unless the user explicitly asks otherwise):
1. Sales = rows WHERE line_type = 'sale' (not cancelled, quantity > 0, price > 0, not bad-debt).
2. Returns/cancellations = rows WHERE line_type = 'cancellation'. Their quantity and line_value are negative.
   "Returned most" = rank by units, SUM(-quantity) over these rows.
   "Returned most frequently / most often" = rank by number of return invoices, COUNT(DISTINCT invoice).
3. Gross revenue (= "revenue excluding cancelled invoices") = SUM(line_value) WHERE line_type = 'sale'.
4. Net revenue (default meaning of "revenue", "sales", "sales value", "net sales") =
   SUM(line_value) WHERE line_type IN ('sale', 'cancellation')  (sales minus returns).
5. Total transaction value = SUM(line_value) over ALL rows (no filter). Only use when explicitly asked.
6. Stock adjustments (line_type = 'stock_adjustment', negative qty that is not a return, price 0) and
   zero_price / bad_debt_adjustment rows are never sales or returns.
7. Product rankings (top products, most returned products): add AND is_product = TRUE and group by stock_code
   (show description too, using any_value(description) or max(description)).
8. Customer analysis (per-customer rankings/counts): add AND customer_id IS NOT NULL and say unknown customers
   were excluded. Aggregate totals (revenue, country revenue) keep rows with unknown customers.
   Counting customers who bought / purchased / ordered (e.g. "how many customers made a purchase"): use only
   line_type = 'sale' rows, so customers who only cancelled or returned are not counted.
9. Order / invoice counts: COUNT(DISTINCT invoice). Cancelled invoice count = COUNT(DISTINCT invoice) WHERE is_cancelled.
10. Money is {money}. Round money to 2 decimals. Name money columns with the suffix _{sfx} (e.g. net_revenue_{sfx}).
11. Dates: data covers {start[:10]} to {end[:10]}. Years are calendar years
    (e.g. {ty} = invoice_date >= '{ty}-01-01' AND invoice_date < '{ty + 1}-01-01'). Use half-open ranges.
{relative}
    "This year" = {ty} and "last year" = {ly} (the latest year in the data and the one before it). Do NOT ask; state
    the assumption ("This year means {ty}, the latest year in the data; it ends on {p['end_label']}.").
12. Always add a LIMIT (<= 200) for row-level or ranking results.
13. "Best / top / highest / biggest" month, quarter, country, customer or product = highest NET revenue unless another
    measure is named ("best month for returns" = most units returned). "Worst / lowest" = lowest net revenue.
    "Best sales month" = the calendar month with the highest net revenue.
14. MULTI-STEP QUESTIONS: when one part of the question depends on the answer to another part (e.g. "top products in the
    best month", "top countries for the best-selling product", "returns in the country with the highest revenue"),
    answer it in ONE statement with WITH (CTE) steps: first compute the inner answer, then filter by it. Also return the
    inner answer as a column (e.g. best_month) so the user can see which month/country was used.
    Example: "top 5 products by revenue in the best sales month of {ty}" ->
      WITH best_month AS (
        SELECT date_trunc('month', invoice_date) AS month FROM transactions
        WHERE line_type IN ('sale', 'cancellation') AND invoice_date >= '{ty}-01-01' AND invoice_date < '{ty + 1}-01-01'
        GROUP BY 1 ORDER BY SUM(line_value) DESC LIMIT 1)
      SELECT strftime((SELECT month FROM best_month), '%Y-%m') AS best_month, stock_code,
             any_value(description) AS description, ROUND(SUM(line_value), 2) AS net_revenue_{sfx}
      FROM transactions
      WHERE line_type IN ('sale', 'cancellation') AND is_product
        AND date_trunc('month', invoice_date) = (SELECT month FROM best_month)
      GROUP BY stock_code ORDER BY net_revenue_{sfx} DESC LIMIT 5
    Example: "which country returned the most units of the best-selling product?" ->
      WITH top_product AS (SELECT stock_code FROM transactions WHERE line_type = 'sale' AND is_product
                           GROUP BY stock_code ORDER BY SUM(quantity) DESC LIMIT 1)
      SELECT country, any_value(description) AS product, SUM(-quantity) AS returned_units FROM transactions
      WHERE line_type = 'cancellation' AND stock_code = (SELECT stock_code FROM top_product)
      GROUP BY country ORDER BY returned_units DESC LIMIT 10
""".strip()

    asks = ""
    if ask_quarter:
        asks += f"""
- "last quarter" (or "previous quarter") with no quarter named: ask which quarter, with exactly these options:
  "{p['quarter_options'][0]}" and "{p['quarter_options'][1]}"."""
    if ask_month:
        asks += f"""
- "last month" with no month named: ask which month, with options "{p['month_options'][0]}" and "{p['month_options'][1]}"."""
    if asks:
        asks += "\n  Once the user has picked a quarter or month (it appears in the conversation), use it and do not ask again."
    ambiguity = f"""
ASK A CLARIFYING QUESTION (do not write SQL) when the metric that decides the answer is not stated, for example:
- "best/top/biggest customers" without saying by revenue, number of orders or units.
- "top/best products" without saying by revenue or by quantity sold.
- "how are we doing", "performance" or other vague requests with no metric.
- a country/product/customer name that does not exist or could mean several things.{asks}
Do NOT ask when the data rules above already define the term. These are defined, so answer them directly:
- "revenue", "sales", "most revenue", "highest revenue" -> net revenue (rule 4); "excluding cancelled" -> gross (rule 3).
- "returned most" -> units returned; "returned most often/frequently" -> number of return invoices (rule 2).
- "customers who generated the most revenue" names the metric, so do not ask.
- "this year" -> {ty}, "last year" -> {ly} (rule 11); "best month", "best sales month", "best country" -> by net revenue (rule 13).
- Multi-part questions ("top products in the best month of this year") are NOT ambiguous just because they have
  several parts: break them into steps (rule 14) and answer.
""".strip()
    return {"schema": schema, "rules": rules, "ambiguity": ambiguity, "periods": p}


def generic_rules(table: str, columns: list[dict], sample_rows: list[list], row_count: int,
                  date_range: list | None, source: str) -> dict:
    """Prompt text for a user's own table that doesn't look like retail sales."""
    cols = "\n".join(f"  {c['name']:<24} {c['type']}" for c in columns)
    sample = "\n".join("  " + " | ".join(str(v)[:40] for v in r) for r in sample_rows[:5])
    schema = f"""Table: {table}  ({row_count:,} rows, uploaded by the user from "{source}")
{cols}
Sample rows (columns in the order above):
{sample}""".strip()
    period = ""
    if date_range and date_range[1]:
        p = periods(str(date_range[1]))
        period = f"""
5. Dates in the data run from {str(date_range[0])[:10]} to {str(date_range[1])[:10]}. Relative periods ("this year", "last month")
   are relative to the END of the data, not today: "this year" = {p['this_year']}, "last year" = {p['last_year']}. State it."""
    rules = f"""
DATA RULES for this user-uploaded table:
1. Use only the columns listed. Quote column names with double quotes if they are not plain lowercase identifiers.
2. Work out what each column means from its name, type and the sample rows; say in "assumptions" how you interpreted
   the columns you used (in plain English).
3. Money: the currency is not known; don't add a currency symbol. Round money-like values to 2 decimals.
4. Always add a LIMIT (<= 200) for row-level or ranking results.{period}
6. MULTI-STEP QUESTIONS: if one part depends on another ("top items in the best month"), use WITH (CTE) steps in ONE
   statement and also return the inner answer as a column.""".strip()
    ambiguity = """
ASK A CLARIFYING QUESTION (do not write SQL) only when the question can't be answered without a choice the user must
make (e.g. "best customers" when there are several possible measures), or no column matches what is asked.
Offer 2-4 concrete options based on the actual columns.""".strip()
    return {"schema": schema, "rules": rules, "ambiguity": ambiguity, "periods": None}


_BUILTIN = retail_rules(DATASET_START, DATASET_END)
SCHEMA_DOC = _BUILTIN["schema"]
DATA_RULES = _BUILTIN["rules"]
AMBIGUITY_RULES = _BUILTIN["ambiguity"]
LAST_FULL_QUARTER = _BUILTIN["periods"]["full_quarter"]
QUARTER_OPTIONS = _BUILTIN["periods"]["quarter_options"]
MONTH_OPTIONS = _BUILTIN["periods"]["month_options"]
