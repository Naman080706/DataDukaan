"""Short-horizon monthly forecasts with prediction intervals (no extra dependencies).

Four small models are tried on the monthly series and the one with the lowest error in a
rolling back-test (every step of the horizon, not just the next month) is used:
  - seasonal: the same month last year, scaled by recent year-on-year growth
  - trend: Holt's linear exponential smoothing (level + trend)
  - average: mean of the last 3 months
  - blend: the mean of seasonal and trend
Intervals come from the chosen model's own back-test errors at each step ahead (relative to the forecast),
so a model that back-tested badly gets honestly wide intervals.
The data ends on 9 Dec 2011, so the last complete month is November 2011 and forecasts start in December 2011.
"""
import math
import re
import statistics

from . import db
from .validator import validate_sql

FIRST_MONTH = "2009-12"
LAST_FULL_MONTH = "2011-11"
Z80, Z95 = 1.2816, 1.96

# metric -> (aggregate, line filter, label, unit)
METRICS = {
    "net_revenue": ("SUM(line_value)", "line_type IN ('sale', 'cancellation')", "Net revenue", "gbp"),
    "units_sold": ("SUM(quantity)", "line_type = 'sale'", "Units sold", "count"),
    "orders": ("COUNT(DISTINCT invoice)", "line_type = 'sale'", "Orders", "count"),
    "returned_units": ("SUM(-quantity)", "line_type = 'cancellation'", "Units returned", "count"),
    "return_value": ("SUM(-line_value)", "line_type = 'cancellation'", "Value of returns", "gbp"),
}
RETURN_METRICS = {"returned_units", "return_value"}
SCOPES = ("total", "country", "product")
MODEL_INFO = {
    "seasonal": "Same month last year, scaled by recent year-on-year growth",
    "trend": "Recent level and trend (Holt's exponential smoothing)",
    "average": "Average of the last 3 months",
    "blend": "Average of the seasonal and trend forecasts",
}


class ForecastError(ValueError):
    pass


def month_range(start: str, end: str) -> list[str]:
    y, m = map(int, start.split("-"))
    out = []
    while f"{y}-{m:02d}" <= end:
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def next_months(after: str, n: int) -> list[str]:
    y, m = map(int, after.split("-"))
    out = []
    for _ in range(n):
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        out.append(f"{y}-{m:02d}")
    return out


# --- Models: each takes the history and a horizon and returns h point forecasts (or None if it can't). ---

def _seasonal(y: list[float], h: int) -> list[float] | None:
    n = len(y)
    if n < 13:
        return None
    k = min(12, n - 12)
    prev = sum(y[n - 12 - k:n - 12])
    growth = sum(y[n - k:]) / prev if prev > 0 else 1.0
    growth = min(max(growth, 0.5), 2.0)  # one odd year must not double or halve every forecast
    return [max(y[n - 12 + i % 12] * growth, 0.0) for i in range(h)]


def _holt_fit(y: list[float], alpha: float, beta: float) -> tuple[float, float, float]:
    level, trend, sse = y[0], (y[1] - y[0]) if len(y) > 1 else 0.0, 0.0
    for v in y[1:]:
        pred = level + trend
        sse += (v - pred) ** 2
        new_level = alpha * v + (1 - alpha) * pred
        trend = beta * (new_level - level) + (1 - beta) * trend
        level = new_level
    return level, trend, sse


def _trend(y: list[float], h: int) -> list[float] | None:
    if len(y) < 4:
        return None
    best = min(((a, b) for a in (0.2, 0.4, 0.6, 0.8) for b in (0.0, 0.1, 0.3)), key=lambda p: _holt_fit(y, *p)[2])
    level, trend, _ = _holt_fit(y, *best)
    return [max(level + trend * (i + 1), 0.0) for i in range(h)]


def _average(y: list[float], h: int) -> list[float] | None:
    if not y:
        return None
    return [sum(y[-3:]) / len(y[-3:])] * h


def _blend(y: list[float], h: int) -> list[float] | None:
    """Average of the seasonal and trend forecasts: combining models is usually safer than picking one."""
    s, t = _seasonal(y, h), _trend(y, h)
    if s is None or t is None:
        return None
    return [(a + b) / 2 for a, b in zip(s, t)]


MODELS = {"seasonal": _seasonal, "trend": _trend, "average": _average, "blend": _blend}


def cap_spikes(y: list[float]) -> tuple[list[float], float | None]:
    """Cap one-off spikes (a single bulk cancellation can be 8x a normal month) at median + 5 x MAD."""
    if len(y) < 6:
        return y, None
    med = statistics.median(y)
    mad = statistics.median(abs(v - med) for v in y) or (med * 0.1) or 1.0
    cap = med + 5 * mad
    return [min(v, cap) for v in y], cap if any(v > cap for v in y) else None


def backtest(y: list[float], horizon: int = 3) -> dict:
    """Rolling-origin back-test over (up to) the last 12 months: from each origin, forecast `horizon` months ahead
    and compare with what happened. Models are judged on every step, so one that ignores seasonality loses."""
    n = len(y)
    origins = list(range(max(13, n - 12), n)) if n >= 16 else list(range(max(3, n - 4), n))
    floor = max(sum(y) / max(n, 1) * 0.1, 1.0)
    out = {}
    for name, fn in MODELS.items():
        runs = [(o, fn(y[:o], horizon)) for o in origins]
        if not origins or any(p is None for _, p in runs):
            continue
        steps = [(o + h, h + 1, y[o + h], p[h]) for o, p in runs for h in range(horizon) if o + h < n]
        # Spread per step ahead; with under 3 errors at a step, pool all steps (scaled by sqrt(h)), and with
        # under 3 errors in total assume +/-100%, so thin history never gives a falsely narrow range.
        rel = [((a - f) / max(f, floor), hh) for _, hh, a, f in steps]
        pooled = math.sqrt(sum(e * e / hh for e, hh in rel) / len(rel)) if len(rel) >= 3 else 1.0
        rel_sd = []
        for h in range(1, horizon + 1):
            errs = [e for e, hh in rel if hh == h]
            rel_sd.append(math.sqrt(sum(e * e for e in errs) / len(errs)) if len(errs) >= 3 else max(pooled, 0.1) * math.sqrt(h))
        out[name] = {
            "points": [(t, a, f) for t, hh, a, f in steps if hh == 1],
            "mape": sum(abs(a - f) / max(a, floor) for _, _, a, f in steps) / len(steps),
            "rel_sd": rel_sd,
        }
    return out


def forecast_series(history: list[tuple[str, float]], horizon: int = 3, robust: bool = False) -> dict:
    """Forecast a monthly series given as [(period, value)]. Pure function, so it is easy to test."""
    periods = [p for p, _ in history]
    raw = [float(v or 0.0) for _, v in history]
    y, cap = cap_spikes(raw) if robust else (raw, None)
    tests = backtest(y, horizon)
    if not tests:
        raise ForecastError("Not enough history to forecast this (at least 4 months are needed).")
    name = min(tests, key=lambda k: tests[k]["mape"])
    chosen = tests[name]
    preds = MODELS[name](y, horizon)
    spreads = [chosen["rel_sd"][i] * max(f, 1.0) for i, f in enumerate(preds)]
    points = []
    for period, f, spread in zip(next_months(periods[-1], horizon), preds, spreads):
        points.append({"period": period, "value": round(f, 2),
                       "lo80": round(max(f - Z80 * spread, 0.0), 2), "hi80": round(f + Z80 * spread, 2),
                       "lo95": round(max(f - Z95 * spread, 0.0), 2), "hi95": round(f + Z95 * spread, 2)})
    # Horizon total: errors are treated as independent month to month (an approximation, stated in the notes).
    total = sum(p["value"] for p in points)
    total_spread = math.sqrt(sum(sp ** 2 for sp in spreads))
    return {
        "history": [{"period": p, "value": round(v, 2)} for p, v in zip(periods, raw)],
        "forecast": points,
        "total": {"value": round(total, 2), "lo80": round(max(total - Z80 * total_spread, 0), 2), "hi80": round(total + Z80 * total_spread, 2)},
        "model": {"name": name, "description": MODEL_INFO[name]},
        "backtest": {
            "mape": round(chosen["mape"], 4),
            "points": [{"period": periods[t], "actual": round(raw[t], 2), "predicted": round(f, 2)} for t, _, f in chosen["points"]],
            "models": [{"name": k, "description": MODEL_INFO[k], "mape": round(v["mape"], 4)} for k, v in sorted(tests.items(), key=lambda kv: kv[1]["mape"])],
        },
        "capped": [{"period": p, "value": round(v, 2)} for p, v in zip(periods, raw) if cap is not None and v > cap],
        "cap": round(cap, 2) if cap is not None else None,
    }


# --- Data access: monthly series for the whole shop, one country or one product. ---

def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def resolve_entity(scope: str, key: str | None) -> tuple[str | None, str]:
    """Check a country / stock code exists (case-insensitive) and return (canonical key, display label)."""
    if scope == "total":
        return None, "the whole shop"
    if not key or not key.strip():
        raise ForecastError(f"Name a {scope} to forecast.")
    key = key.strip()
    if scope == "country":
        rows = db.execute_readonly_sql(
            f"SELECT DISTINCT country FROM transactions WHERE lower(country) = lower({_quote(key)})")["rows"]
        if not rows:
            raise ForecastError(f"There is no country called “{key}” in the sales records.")
        return rows[0][0], rows[0][0]
    rows = db.execute_readonly_sql(
        f"SELECT stock_code, any_value(description) FROM transactions WHERE upper(stock_code) = upper({_quote(key)}) "
        f"AND is_product GROUP BY stock_code ORDER BY stock_code = {_quote(key)} DESC, COUNT(*) DESC")["rows"]
    if not rows:
        raise ForecastError(f"There is no product with the code “{key}”.")
    return rows[0][0], f"{rows[0][0]} {rows[0][1] or ''}".strip()


def series_sql(metric: str, scope: str = "total", key: str | None = None) -> str:
    agg, base, _, _ = METRICS[metric]
    where = [base, f"invoice_date < '{next_months(LAST_FULL_MONTH, 1)[0]}-01'"]
    if scope == "country":
        where.append(f"country = {_quote(key)}")
    elif scope == "product":
        where += ["is_product", f"stock_code = {_quote(key)}"]
    return (f"SELECT strftime(invoice_date, '%Y-%m') AS month, ROUND({agg}, 2) AS value FROM transactions "
            f"WHERE {' AND '.join(where)} GROUP BY 1 ORDER BY 1")


def monthly_series(metric: str, scope: str = "total", key: str | None = None) -> tuple[list[tuple[str, float]], str]:
    """Every month from the first month with activity to Nov 2011, with 0 for months with none."""
    sql = validate_sql(series_sql(metric, scope, key))
    found = {r[0]: float(r[1] or 0) for r in db.execute_readonly_sql(sql)["rows"]}
    months = month_range(FIRST_MONTH, LAST_FULL_MONTH)
    first = next((i for i, m in enumerate(months) if found.get(m)), None)
    if first is None:
        return [], sql
    return [(m, found.get(m, 0.0)) for m in months[first:]], sql


def forecast(metric: str = "net_revenue", scope: str = "total", key: str | None = None, horizon: int = 3) -> dict:
    if metric not in METRICS:
        raise ForecastError(f"Unknown measure “{metric}”. Choose one of: {', '.join(METRICS)}.")
    if scope not in SCOPES:
        raise ForecastError(f"Unknown breakdown “{scope}”.")
    horizon = min(max(int(horizon), 1), 6)
    key, label = resolve_entity(scope, key)
    history, sql = monthly_series(metric, scope, key)
    if len(history) < 4:
        raise ForecastError(f"{label} has too little history to forecast (it needs at least 4 months of activity).")
    result = forecast_series(history, horizon, robust=metric in RETURN_METRICS)
    _, _, metric_label, unit = METRICS[metric]
    notes = [
        "The data ends on 9 December 2011, so the forecast starts with December 2011 and is based on months up to November 2011.",
        f"Model chosen by testing each one on the past {len(result['backtest']['points'])} months, up to {horizon} months ahead: "
        f"{MODEL_INFO[result['model']['name']].lower()}. Typical error in those tests: {result['backtest']['mape']:.0%}.",
        "The ranges show where the real figure should fall 80% and 95% of the time, judged by how wrong the model was in those tests.",
    ]
    if result["capped"]:
        spikes = ", ".join(f"{p['period']} ({p['value']:,.0f})" for p in result["capped"])
        notes.append(f"One-off spikes were capped at {result['cap']:,.0f} so a single bulk return doesn't drive the forecast: {spikes}.")
    if len(result["forecast"]) > 1:
        notes.append("The total's range treats each month's error as independent, so it is approximate.")
    return {"metric": metric, "metric_label": metric_label, "unit": unit, "scope": scope, "key": key, "label": label,
            "horizon": horizon, "sql": sql, "notes": notes, **result}


# --- Plain-English forecast questions ("what should I expect next month?", "forecast returns for Germany"). ---

FORECAST_WORDS = re.compile(r"\b(forecast\w*|predict\w*|project\w*|expect\w*|outlook|next (?:\d+ )?(?:month|quarter|30 days|90 days|months)|"
                            r"coming (?:month|quarter|months)|will (?:we|our|the|it)\b.*\b(?:sell|make|earn|be|get))")


def parse_question(question: str, countries: list[str]) -> dict | None:
    """Turn a forecast question into forecast() arguments, or None if it isn't about the future."""
    q = question.lower().replace("’", "'")
    if not FORECAST_WORDS.search(q):
        return None
    if re.search(r"\breturn", q):
        metric = "return_value" if re.search(r"\b(value|£|money|cost|worth)\b", q) else "returned_units"
    elif re.search(r"\b(units|quantity|volume|items sold)\b", q):
        metric = "units_sold"
    elif re.search(r"\b(orders|invoices)\b", q):
        metric = "orders"
    else:
        metric = "net_revenue"
    m = re.search(r"\bnext (\d+) months\b", q)
    horizon = int(m.group(1)) if m else 3 if re.search(r"\b(quarter|90 days|3 months|three months)\b", q) else \
        1 if re.search(r"\b(next month|30 days|coming month)\b", q) else 3
    code = re.search(r"\b(\d{5}[a-zA-Z]{0,2})\b", question)
    country = next((c for c in countries if re.search(r"\b" + re.escape(c.lower()) + r"\b", q)), None)
    scope, key = ("product", code.group(1)) if code else ("country", country) if country else ("total", None)
    return {"metric": metric, "scope": scope, "key": key, "horizon": min(horizon, 6)}
