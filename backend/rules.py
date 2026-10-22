"""Single source of truth for the retail data rules.

Used by ingestion (flag columns), the LLM prompt (so generated SQL follows the
same definitions) and the trap-suite reference SQL.
"""

# Stock codes that are not physical products (postage, fees, manual adjustments...).
NON_PRODUCT_CODES = [
    "POST", "DOT", "M", "MANUAL", "BANK CHARGES", "PADS", "C2", "C3", "CRUK",
    "D", "AMAZONFEE", "S", "B", "SP1002",
]
NON_PRODUCT_CODES_SQL = ", ".join(f"'{c}'" for c in NON_PRODUCT_CODES)

DATASET_START = "2009-12-01"
DATASET_END = "2011-12-09"
LAST_FULL_QUARTER = ("2011-07-01", "2011-10-01")  # Q3 2011, the last complete quarter in the data
# The data ends mid-quarter (9 Dec 2011), so "last quarter" could mean either of these; the agent asks.
QUARTER_OPTIONS = ["Q3 2011 (Jul to Sep, the last complete quarter)", "Q4 2011 so far (1 Oct to 9 Dec)"]
MONTH_OPTIONS = ["November 2011 (the last complete month)", "December 2011 so far (1 to 9 Dec)"]

SCHEMA_DOC = """
Table: transactions  (one row per invoice line, UCI Online Retail II, Dec 2009 - Dec 2011)
  invoice        VARCHAR   invoice number; starts with 'C' = cancellation/credit note, 'A' = bad-debt adjustment
  stock_code     VARCHAR   product code (some codes are not products, see is_product)
  description    VARCHAR   product description (may be NULL)
  quantity       INTEGER   units; negative on cancellations and stock adjustments
  invoice_date   TIMESTAMP date and time of the invoice
  price          DOUBLE    unit price in GBP (pounds sterling)
  customer_id    VARCHAR   customer id, NULL when unknown (~20% of lines)
  country        VARCHAR   customer country
  line_value     DOUBLE    quantity * price in GBP (negative on cancellations)
  is_cancelled   BOOLEAN   invoice starts with 'C'
  is_negative_qty BOOLEAN  quantity < 0
  has_customer   BOOLEAN   customer_id IS NOT NULL
  is_product     BOOLEAN   FALSE for postage, fees, manual adjustments, bank charges, samples, test codes
  line_type      VARCHAR   one of: 'sale', 'cancellation', 'stock_adjustment', 'zero_price', 'bad_debt_adjustment'
""".strip()

DATA_RULES = f"""
DATA RULES (apply to every query unless the user explicitly asks otherwise):
1. Sales = rows WHERE line_type = 'sale' (not cancelled, quantity > 0, price > 0, not bad-debt).
2. Returns/cancellations = rows WHERE line_type = 'cancellation' (invoice starts with 'C'). Their quantity and
   line_value are negative. "Returned most" = rank by units, SUM(-quantity) over these rows.
   "Returned most frequently / most often" = rank by number of return invoices, COUNT(DISTINCT invoice).
3. Gross revenue (= "revenue excluding cancelled invoices") = SUM(line_value) WHERE line_type = 'sale'.
4. Net revenue (default meaning of "revenue", "sales", "sales value", "net sales") =
   SUM(line_value) WHERE line_type IN ('sale', 'cancellation')  (sales minus returns).
5. Total transaction value = SUM(line_value) over ALL rows (no filter). Only use when explicitly asked.
6. Stock adjustments (line_type = 'stock_adjustment', negative qty without a 'C' invoice, price 0) and
   zero_price / bad_debt_adjustment rows are never sales or returns.
7. Product rankings (top products, most returned products): add AND is_product = TRUE and group by stock_code
   (show description too, using any_value(description) or max(description)).
8. Customer analysis (per-customer rankings/counts): add AND customer_id IS NOT NULL and say unknown customers
   were excluded. Aggregate totals (revenue, country revenue) keep rows with unknown customers.
   Counting customers who bought / purchased / ordered (e.g. "how many customers made a purchase"): use only
   line_type = 'sale' rows, so customers who only cancelled or returned are not counted.
9. Order / invoice counts: COUNT(DISTINCT invoice). Cancelled invoice count = COUNT(DISTINCT invoice) WHERE is_cancelled.
10. Money is GBP (pounds sterling). Round money to 2 decimals.
11. Dates: data covers {DATASET_START} to {DATASET_END}. Years are calendar years
    (e.g. 2011 = invoice_date >= '2011-01-01' AND invoice_date < '2012-01-01'). Use half-open ranges.
    Relative periods ("last quarter", "last month") are relative to the end of the data (9 Dec 2011), NOT today,
    and are ambiguous because the data stops part-way through Q4 2011: ask which one is meant (see below).
    Q3 2011 = invoice_date >= '{LAST_FULL_QUARTER[0]}' AND invoice_date < '{LAST_FULL_QUARTER[1]}';
    Q4 2011 so far = invoice_date >= '2011-10-01' AND invoice_date < '2012-01-01'.
    November 2011 = '2011-11-01' to '2011-12-01'; December 2011 so far = '2011-12-01' to '2012-01-01'.
12. Always add a LIMIT (<= 200) for row-level or ranking results.
""".strip()

AMBIGUITY_RULES = f"""
ASK A CLARIFYING QUESTION (do not write SQL) when the metric that decides the answer is not stated, for example:
- "best/top/biggest customers" without saying by revenue, number of orders or units.
- "top/best products" without saying by revenue or by quantity sold.
- "how are we doing", "performance" or other vague requests with no metric.
- a country/product/customer name that does not exist or could mean several things.
- "last quarter" (or "previous quarter") with no quarter named: ask which quarter, with exactly these options:
  "{QUARTER_OPTIONS[0]}" and "{QUARTER_OPTIONS[1]}".
- "last month" with no month named: ask which month, with options "{MONTH_OPTIONS[0]}" and "{MONTH_OPTIONS[1]}".
  Once the user has picked a quarter or month (it appears in the conversation), use it and do not ask again.
Do NOT ask when the data rules above already define the term. These are defined, so answer them directly:
- "revenue", "sales", "most revenue", "highest revenue" -> net revenue (rule 4); "excluding cancelled" -> gross (rule 3).
- "returned most" -> units returned; "returned most often/frequently" -> number of return invoices (rule 2).
- "customers who generated the most revenue" names the metric, so do not ask.
""".strip()
