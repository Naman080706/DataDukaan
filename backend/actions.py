"""Prescriptive layer: forecasts + written business rules -> a ranked action list.

Two steps, both deterministic so every number in an action can be traced to a query:
  1. Diagnose: mark the top products and countries Critical / Watch / Healthy against shop-wide benchmarks
     and their own forecasts (rules in BUSINESS_RULES).
  2. Recommend: turn each finding into a concrete action, ranked by severity x money at stake.
"""
from . import db
from .forecast import forecast_series, month_range, next_months, LAST_FULL_MONTH
from .validator import validate_sql

LAST_12 = ("2010-12-01", "2011-12-01")    # Dec 2010 - Nov 2011, the last 12 complete months
PRIOR_12 = ("2009-12-01", "2010-12-01")
HORIZON = 3                                # Dec 2011 - Feb 2012
SAME_MONTHS_LAST_YEAR = ("2010-12-01", "2011-03-01")
TOP_PRODUCTS = 40
TOP_COUNTRIES = 12

RATE_CRITICAL, RATE_WATCH = 3.0, 1.5       # x the shop's product return rate
MIN_RETURNED_CRITICAL, MIN_RETURNED_WATCH = 100, 30
FORECAST_RETURN_ALLOWANCE = 1.5            # returns allowed = 1.5 x shop rate x forecast units sold
CONCENTRATION_SHARE = 0.40                 # 2 customers behind >= 40% of a product's returns
DECLINE_CRITICAL, DECLINE_WATCH = -0.15, -0.05
COUNTRY_RETURNS_WATCH = 2.0                # x the shop's return value share
SEVERITY_WEIGHT = {"Critical": 3, "Watch": 2, "Opportunity": 1}

BUSINESS_RULES = [
    {"id": "R1", "applies_to": "product", "name": "Return rate far above the shop's",
     "rule": f"Critical when a product's units returned / units sold over the last 12 months is at least {RATE_CRITICAL:g}x the shop's "
             f"rate (and {MIN_RETURNED_CRITICAL}+ units came back); Watch at {RATE_WATCH:g}x ({MIN_RETURNED_WATCH}+ units)."},
    {"id": "R2", "applies_to": "product", "name": "Returns forecast to exceed the allowance",
     "rule": f"Returns allowed next quarter = {FORECAST_RETURN_ALLOWANCE:g}x the shop's return rate x the product's forecast units sold. "
             "Critical when even the low end of the 80% range is above it; Watch when the central forecast is. Needs 12+ months of history."},
    {"id": "R3", "applies_to": "product", "name": "A few customers drive the returns",
     "rule": f"Flag the two customers behind {CONCENTRATION_SHARE:.0%}+ of a flagged product's returned units."},
    {"id": "R4", "applies_to": "country", "name": "Revenue forecast to fall",
     "rule": f"Compare a country's forecast net revenue for the next 3 months with the same months last year: Critical when "
             f"even the top of the 80% range is {-DECLINE_CRITICAL:.0%}+ below, Watch when the central forecast is {-DECLINE_WATCH:.0%}+ below."},
    {"id": "R5", "applies_to": "country", "name": "High share of sales returned",
     "rule": f"Watch when the value of a country's returns / its sales over the last 12 months is {COUNTRY_RETURNS_WATCH:g}x the shop's."},
    {"id": "R6", "applies_to": "product", "name": "Stock up for forecast demand",
     "rule": "For healthy best-sellers whose forecast for next month is above their usual month even at the low end of the 80% "
             "range, plan stock for the top of the range."},
]


def _run(sql: str, max_rows: int = db.MAX_ROWS) -> list[list]:
    return db.execute_readonly_sql(validate_sql(sql), max_rows=max_rows)["rows"]


def _series(rows: list[list], key_idx: int, val_idx: int) -> dict[str, list[tuple[str, float]]]:
    """Group (key, month, value...) rows into full monthly series per key, from its first active month."""
    months = month_range("2009-12", LAST_FULL_MONTH)
    by_key: dict[str, dict[str, float]] = {}
    for r in rows:
        by_key.setdefault(r[key_idx], {})[r[1]] = float(r[val_idx] or 0)
    out = {}
    for k, found in by_key.items():
        first = next((i for i, m in enumerate(months) if found.get(m)), len(months))
        out[k] = [(m, found.get(m, 0.0)) for m in months[first:]]
    return out


def _fc(series: list[tuple[str, float]], robust: bool = False) -> dict | None:
    if len(series) < 4:
        return None
    return forecast_series(series, HORIZON, robust=robust)


def _period_text() -> str:
    months = next_months(LAST_FULL_MONTH, HORIZON)
    return f"{months[0]} to {months[-1]}"


def _in_list(keys: list[str]) -> str:
    return ", ".join("'" + k.replace("'", "''") + "'" for k in keys)


# The most common description on sale lines: stock-adjustment lines sometimes carry notes like "Damaged".
PRODUCT_STATS_SQL = """SELECT stock_code, mode(description) FILTER (WHERE line_type = 'sale') AS description,
  SUM(quantity) FILTER (WHERE line_type = 'sale') AS units_sold,
  COALESCE(SUM(-quantity) FILTER (WHERE line_type = 'cancellation'), 0) AS returned_units,
  ROUND(COALESCE(SUM(-line_value) FILTER (WHERE line_type = 'cancellation'), 0), 2) AS return_value_gbp,
  ROUND(SUM(line_value) FILTER (WHERE line_type IN ('sale', 'cancellation')), 2) AS net_revenue_gbp
FROM transactions WHERE is_product AND invoice_date >= '{start}' AND invoice_date < '{end}'
GROUP BY stock_code HAVING SUM(quantity) FILTER (WHERE line_type = 'sale') >= 50
ORDER BY {order} DESC NULLS LAST LIMIT {limit}"""

COUNTRY_STATS_SQL = """SELECT country,
  ROUND(SUM(line_value) FILTER (WHERE line_type IN ('sale', 'cancellation')), 2) AS net_revenue_gbp,
  ROUND(SUM(line_value) FILTER (WHERE line_type = 'sale'), 2) AS gross_revenue_gbp,
  ROUND(COALESCE(SUM(-line_value) FILTER (WHERE line_type = 'cancellation'), 0), 2) AS return_value_gbp
FROM transactions WHERE invoice_date >= '{start}' AND invoice_date < '{end}'
GROUP BY country ORDER BY net_revenue_gbp DESC LIMIT {limit}"""


def benchmarks() -> dict:
    s, e = LAST_12
    units, returned = _run(f"SELECT SUM(quantity) FILTER (WHERE line_type = 'sale'), SUM(-quantity) FILTER (WHERE line_type = 'cancellation') "
                           f"FROM transactions WHERE is_product AND invoice_date >= '{s}' AND invoice_date < '{e}'")[0]
    gross, ret_value = _run(f"SELECT SUM(line_value) FILTER (WHERE line_type = 'sale'), SUM(-line_value) FILTER (WHERE line_type = 'cancellation') "
                            f"FROM transactions WHERE invoice_date >= '{s}' AND invoice_date < '{e}'")[0]
    return {"product_return_rate": round(returned / units, 4), "return_value_share": round(ret_value / gross, 4),
            "period": "December 2010 to November 2011 (the last 12 complete months)"}


def diagnose_products(bench: dict) -> list[dict]:
    s, e = LAST_12
    stats = {}
    for order, limit in (("net_revenue_gbp", TOP_PRODUCTS), ("returned_units", 15)):
        for r in _run(PRODUCT_STATS_SQL.format(start=s, end=e, order=order, limit=limit)):
            stats[r[0]] = {"code": r[0], "description": r[1], "units_sold": r[2], "returned_units": r[3],
                           "return_value_gbp": r[4], "net_revenue_gbp": r[5]}
    rows = _run(f"SELECT stock_code, strftime(invoice_date, '%Y-%m') AS month, "
                f"SUM(quantity) FILTER (WHERE line_type = 'sale') AS units_sold, "
                f"COALESCE(SUM(-quantity) FILTER (WHERE line_type = 'cancellation'), 0) AS returned_units "
                f"FROM transactions WHERE is_product AND stock_code IN ({_in_list(list(stats))}) AND invoice_date < '{e}' "
                f"GROUP BY 1, 2", max_rows=5000)
    sold_series, ret_series = _series(rows, 0, 2), _series(rows, 0, 3)
    rate = bench["product_return_rate"]
    out = []
    for code, p in stats.items():
        p_rate = p["returned_units"] / p["units_sold"] if p["units_sold"] else 0
        status, reasons, rules = "Healthy", [], []
        ratio = p_rate / rate if rate else 0
        if ratio >= RATE_CRITICAL and p["returned_units"] >= MIN_RETURNED_CRITICAL:
            status, reasons, rules = "Critical", [f"{p_rate:.1%} of units sold came back, {ratio:.1f}x the shop's {rate:.1%}"], ["R1"]
        elif ratio >= RATE_WATCH and p["returned_units"] >= MIN_RETURNED_WATCH:
            status, reasons, rules = "Watch", [f"{p_rate:.1%} of units sold came back, {ratio:.1f}x the shop's {rate:.1%}"], ["R1"]
        f_sold = _fc(sold_series.get(code, []))
        # R2 needs a year of history: a forecast from a few months of returns is mostly noise.
        r_hist = ret_series.get(code, [])
        f_ret = _fc(r_hist, robust=True) if len(r_hist) >= 12 and any(v for _, v in r_hist) else None
        allowance = None
        if f_sold and f_ret:
            allowance = FORECAST_RETURN_ALLOWANCE * rate * f_sold["total"]["value"]
            lo, mid = f_ret["total"]["lo80"], f_ret["total"]["value"]
            if lo > allowance or (mid > allowance and status == "Healthy"):
                level = "Critical" if lo > allowance else "Watch"
                if SEVERITY_WEIGHT[level] > SEVERITY_WEIGHT.get(status, 0):
                    status = level
                reasons.append(f"returns forecast at {mid:,.0f} units for {_period_text()} (80% range {lo:,.0f} to "
                               f"{f_ret['total']['hi80']:,.0f}), above the allowance of {allowance:,.0f}")
                rules.append("R2")
        out.append({**p, "kind": "product", "key": code, "label": f"{p['description']} ({code})", "status": status,
                     "return_rate": round(p_rate, 4), "reasons": reasons, "rules": rules,
                     "forecast_units": f_sold["total"] if f_sold else None, "forecast_next_month_units": f_sold["forecast"][0] if f_sold else None,
                     "avg_month_units": round(p["units_sold"] / 12, 1), "forecast_returns": f_ret["total"] if f_ret else None,
                     "return_allowance": round(allowance, 1) if allowance is not None else None,
                     "model": f_sold["model"]["name"] if f_sold else None})
    return out


def diagnose_countries(bench: dict) -> list[dict]:
    s, e = LAST_12
    stats = {r[0]: {"net_revenue_gbp": r[1], "gross_revenue_gbp": r[2], "return_value_gbp": r[3]}
             for r in _run(COUNTRY_STATS_SQL.format(start=s, end=e, limit=TOP_COUNTRIES))}
    rows = _run(f"SELECT country, strftime(invoice_date, '%Y-%m') AS month, ROUND(SUM(line_value), 2) AS net_revenue_gbp "
                f"FROM transactions WHERE line_type IN ('sale', 'cancellation') AND country IN ({_in_list(list(stats))}) "
                f"AND invoice_date < '{e}' GROUP BY 1, 2", max_rows=5000)
    series = _series(rows, 0, 2)
    last_year = month_range(SAME_MONTHS_LAST_YEAR[0][:7], "2011-02")
    out = []
    for country, c in stats.items():
        status, reasons, rules = "Healthy", [], []
        f = _fc(series.get(country, []))
        before = sum(v for m, v in series.get(country, []) if m in last_year)
        change = (f["total"]["value"] - before) / before if f and before > 0 else None
        if change is not None and change <= DECLINE_WATCH:
            status = "Critical" if f["total"]["hi80"] <= before * (1 + DECLINE_CRITICAL) else "Watch"
            reasons.append(f"net revenue forecast at £{f['total']['value']:,.0f} for {_period_text()}, {change:.0%} against "
                           f"£{before:,.0f} in the same months last year")
            rules.append("R4")
        share = c["return_value_gbp"] / c["gross_revenue_gbp"] if c["gross_revenue_gbp"] else 0
        if share >= COUNTRY_RETURNS_WATCH * bench["return_value_share"]:
            status = "Watch" if status == "Healthy" else status
            reasons.append(f"{share:.1%} of sales value was returned, {share / bench['return_value_share']:.1f}x the shop's "
                           f"{bench['return_value_share']:.1%}")
            rules.append("R5")
        out.append({**c, "kind": "country", "key": country, "label": country, "status": status, "reasons": reasons, "rules": rules,
                     "return_value_share": round(share, 4), "forecast_revenue": f["total"] if f else None,
                     "same_months_last_year_gbp": round(before, 2), "change_vs_last_year": round(change, 4) if change is not None else None,
                     "model": f["model"]["name"] if f else None})
    return out


def return_concentration(codes: list[str]) -> dict[str, list[dict]]:
    """The two customers with the most returned units for each product (last 12 months)."""
    if not codes:
        return {}
    s, e = LAST_12
    rows = _run(f"SELECT stock_code, customer_id, SUM(-quantity) AS returned_units FROM transactions "
                f"WHERE line_type = 'cancellation' AND is_product AND customer_id IS NOT NULL AND stock_code IN ({_in_list(codes)}) "
                f"AND invoice_date >= '{s}' AND invoice_date < '{e}' GROUP BY 1, 2 "
                f"QUALIFY row_number() OVER (PARTITION BY stock_code ORDER BY SUM(-quantity) DESC, customer_id) <= 2", max_rows=5000)
    out: dict[str, list[dict]] = {}
    for code, customer, units in rows:
        out.setdefault(code, []).append({"customer_id": customer, "returned_units": units})
    return out


def _sentence(text: str) -> str:
    return text[0].upper() + text[1:] + "."


def _action(severity: str, entity: dict, rule: str, title: str, detail: str, evidence: list[str], at_stake: float) -> dict:
    at_stake = max(at_stake, 0.0)
    return {"severity": severity, "rule": rule, "title": title, "detail": detail, "evidence": evidence,
            "at_stake_gbp": round(at_stake, 2), "priority": round(SEVERITY_WEIGHT[severity] * (1 + at_stake) ** 0.5, 1),
            "entity": {"kind": entity["kind"], "key": entity["key"], "label": entity["label"]}}


def _product_actions(p: dict, customers: list[dict], bench: dict) -> list[dict]:
    unit_value = p["return_value_gbp"] / p["returned_units"] if p["returned_units"] else 0
    at_stake = p["forecast_returns"]["value"] * unit_value if p["forecast_returns"] else p["return_value_gbp"] / 4
    evidence = [f"Last 12 months: {p['units_sold']:,} units sold, {p['returned_units']:,} returned ({p['return_rate']:.1%}); "
                f"the shop's rate is {bench['product_return_rate']:.1%}."] + [_sentence(r) for r in p["reasons"]]
    out = [_action(p["status"], p, p["rules"][0], f"Find out why {p['description']} ({p['key']}) comes back so often",
                   "Start recording a return reason for this product (the records don't hold one today), and check the listing, "
                   "photos and packing against what customers receive before reordering.", evidence, at_stake)]
    returned = sum(c["returned_units"] for c in customers)
    share = returned / p["returned_units"] if p["returned_units"] else 0
    if customers and share >= CONCENTRATION_SHARE:
        who = "the customer" if len(customers) == 1 else f"the {len(customers)} customers"
        ids = " and ".join(f"{c['customer_id']} ({c['returned_units']:,} units)" for c in customers)
        out.append(_action(p["status"], p, "R3", f"Contact {who} behind {share:.0%} of {p['description']} returns",
                           f"Customers {ids} account for {share:.0%} of this product's returned units. Check whether these were "
                           "bulk orders placed by mistake, and add a confirmation step for unusually large orders.",
                           [f"{returned:,} of {p['returned_units']:,} returned units in the last 12 months."], at_stake * share))
    return out


def _country_action(c: dict) -> dict:
    if "R4" in c["rules"]:
        gap = c["same_months_last_year_gbp"] - c["forecast_revenue"]["value"]
        return _action(c["status"], c, "R4", f"Act on falling sales in {c['key']}",
                       f"Review prices, delivery costs and the best-selling lines for {c['key']}, and contact its biggest "
                       "customers from last winter before the season starts.", [_sentence(r) for r in c["reasons"]], gap)
    return _action(c["status"], c, "R5", f"Look into returns from {c['key']}",
                   f"Check delivery damage and the most-returned products for {c['key']}.",
                   [_sentence(r) for r in c["reasons"]], c["return_value_gbp"] / 4)


def _stock_actions(products: list[dict], limit: int = 3) -> list[dict]:
    out = []
    for p in sorted((p for p in products if p["status"] == "Healthy" and p["forecast_next_month_units"]),
                    key=lambda p: p["net_revenue_gbp"], reverse=True):
        nxt = p["forecast_next_month_units"]
        if nxt["lo80"] <= p["avg_month_units"]:
            continue
        unit_price = p["net_revenue_gbp"] / p["units_sold"] if p["units_sold"] else 0
        out.append(_action("Opportunity", p, "R6", f"Stock up on {p['description']} ({p['key']})",
                           f"Forecast {nxt['value']:,.0f} units in {nxt['period']}, against a usual {p['avg_month_units']:,.0f} a month. "
                           f"Plan stock for up to {nxt['hi80']:,.0f} (the top of the 80% range).",
                           [f"80% range for {nxt['period']}: {nxt['lo80']:,.0f} to {nxt['hi80']:,.0f} units."],
                           (nxt["value"] - p["avg_month_units"]) * unit_price))
        if len(out) == limit:
            break
    return out


def recommend(products: list[dict], countries: list[dict], bench: dict) -> list[dict]:
    flagged = [p for p in products if p["status"] != "Healthy"]
    top2 = return_concentration([p["key"] for p in flagged])
    actions = [a for p in flagged for a in _product_actions(p, top2.get(p["key"], []), bench)]
    actions += [_country_action(c) for c in countries if c["status"] != "Healthy"]
    actions += _stock_actions(products)
    actions.sort(key=lambda a: a["priority"], reverse=True)
    for i, a in enumerate(actions, 1):
        a["rank"] = i
    return actions


def action_plan(limit: int = 12) -> dict:
    bench = benchmarks()
    products, countries = diagnose_products(bench), diagnose_countries(bench)
    actions = recommend(products, countries, bench)
    order = {"Critical": 0, "Watch": 1, "Healthy": 2}
    diagnoses = sorted(products + countries, key=lambda d: (order[d["status"]], -(d.get("net_revenue_gbp") or 0)))
    return {"period": _period_text(), "benchmarks": bench, "rules": BUSINESS_RULES,
            "counts": {s: sum(d["status"] == s for d in diagnoses) for s in order},
            "diagnoses": diagnoses, "actions": actions[:limit], "total_actions": len(actions)}
