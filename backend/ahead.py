"""Answers about the future in the Ask box: forecasts and the action list, shaped like any other answer.

The answer text is written by a template from the tool's own numbers (no AI), so it can always be checked.
"""
import re

from .actions import action_plan
from .forecast import ForecastError, forecast, parse_question

MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
               "November", "December"]
ACTION_WORDS = re.compile(r"\b(what should (?:i|we) (?:do|focus on|fix|prioriti[sz]e)|recommend\w*|action (?:list|plan)|"
                          r"next steps|to-?do list|needs? (?:my|our)? ?attention|what (?:to|should we) fix|priorit(?:y|ies))\b")


def month_name(period: str) -> str:
    y, m = period.split("-")
    return f"{MONTH_NAMES[int(m) - 1]} {y}"


def fmt(unit: str, v: float) -> str:
    return f"£{v:,.0f}" if unit == "gbp" else f"{v:,.0f}"


def is_actions_question(question: str) -> bool:
    return bool(ACTION_WORDS.search(question.lower()))


def forecast_answer(question: str, countries: list[str]) -> dict | None:
    """A response-shaped dict for a forecast question, or None if the question isn't about the future."""
    args = parse_question(question, countries)
    if not args:
        return None
    # "for Narnia": a capitalised place or product that isn't in the records must not quietly become "the whole shop".
    named = re.findall(r"\b(?:for|in|from)\s+((?:[A-Z][\w'&.-]*\s?){1,4})", question)
    unknown = [n.strip() for n in named if args["scope"] == "total" and n.split()[0] not in MONTH_NAMES + ["The", "Next", "Our"]]
    if unknown:
        return {"status": "clarification", "clarification_required": True,
                "answer": f"I couldn't find “{unknown[0]}” in the sales records. What should I forecast?",
                "options": ["Net revenue for the whole shop next quarter", "Net revenue for the United Kingdom next quarter"],
                "trace": [{"tool": "clarify", "status": "ok", "detail": f"unknown name: {unknown[0]}"}]}
    try:
        f = forecast(**args)
    except ForecastError as e:
        return {"status": "unavailable", "answer": str(e), "trace": [{"tool": "forecast", "status": "error", "detail": str(e)}]}
    u, first = f["unit"], f["forecast"][0]
    answer = (f"{f['metric_label']} for {f['label']} is forecast at {fmt(u, first['value'])} in {month_name(first['period'])} "
              f"(80% range {fmt(u, first['lo80'])} to {fmt(u, first['hi80'])})")
    if len(f["forecast"]) > 1:
        t = f["total"]
        answer += (f", and {fmt(u, t['value'])} over the {len(f['forecast'])} months to {month_name(f['forecast'][-1]['period'])} "
                   f"(80% range {fmt(u, t['lo80'])} to {fmt(u, t['hi80'])})")
    answer += f". In back-tests this model was typically {f['backtest']['mape']:.0%} off."
    col = f["metric"] + ("_gbp" if u == "gbp" else "")
    assumptions = list(f["notes"])
    if args["metric"] == "net_revenue" and not re.search(r"\b(revenue|sales|turnover)\b", question.lower()):
        assumptions.insert(0, "No measure was named, so this forecasts net revenue (sales minus returns).")
    return {
        "status": "success", "kind": "forecast", "answer": answer, "title": f"{f['metric_label']} forecast for {f['label']}",
        "sql": f["sql"], "columns": ["month", f"forecast_{col}", "low_80", "high_80", "low_95", "high_95"],
        "rows": [[p["period"], p["value"], p["lo80"], p["hi80"], p["lo95"], p["hi95"]] for p in f["forecast"]],
        "chart_type": "forecast", "assumptions": assumptions, "forecast": f, "model": f"forecast: {f['model']['name']}",
        # Numbers the answer quotes that are not cells of the table, for the claim check.
        "evidence_numbers": [{"label": "forecast total", "value": f["total"]["value"]},
                             {"label": "forecast total, low end of the 80% range", "value": f["total"]["lo80"]},
                             {"label": "forecast total, high end of the 80% range", "value": f["total"]["hi80"]},
                             {"label": "back-test error", "value": f["backtest"]["mape"]},
                             {"label": "months forecast", "value": len(f["forecast"])}],
        "trace": [{"tool": "forecast", "status": "ok",
                   "detail": f"{f['metric']} for {f['label']}, {f['horizon']} months ahead, model {f['model']['name']} "
                             f"(back-test error {f['backtest']['mape']:.0%}); history from the read-only query shown"}],
    }


def actions_answer() -> dict:
    plan = action_plan()
    top = plan["actions"][:3]
    c = plan["counts"]
    answer = (f"Checked {sum(c.values())} top products and countries against the shop's benchmarks and their forecasts for "
              f"{plan['period']}: {c['Critical']} critical, {c['Watch']} to watch. Top actions: "
              + "; ".join(f"({a['rank']}) {a['title']}" for a in top) + ".")
    return {
        "status": "success", "kind": "actions", "answer": answer, "title": "Recommended actions",
        "sql": None, "columns": ["rank", "severity", "action", "about", "at_stake_gbp", "priority"],
        "rows": [[a["rank"], a["severity"], a["title"], a["entity"]["label"], a["at_stake_gbp"], a["priority"]] for a in plan["actions"]],
        "chart_type": "none", "action_plan": plan, "model": "rules + forecasts",
        "evidence_numbers": [{"label": "entities checked", "value": sum(c.values())}, {"label": "critical", "value": c["Critical"]},
                             {"label": "to watch", "value": c["Watch"]}, {"label": "healthy", "value": c["Healthy"]},
                             {"label": "product return rate benchmark", "value": plan["benchmarks"]["product_return_rate"]},
                             {"label": "return value share benchmark", "value": plan["benchmarks"]["return_value_share"]}],
        "assumptions": [f"Benchmarks use {plan['benchmarks']['period']}: {plan['benchmarks']['product_return_rate']:.1%} of product "
                        f"units sold came back, and {plan['benchmarks']['return_value_share']:.1%} of sales value.",
                        "Actions are ranked by how serious the finding is and how much money is at stake."],
        "trace": [{"tool": "diagnose", "status": "ok", "detail": f"{c['Critical']} critical, {c['Watch']} watch, {c['Healthy']} healthy"},
                  {"tool": "recommend", "status": "ok", "detail": f"{plan['total_actions']} actions from rules "
                                                                  + ", ".join(r["id"] for r in plan["rules"])}],
    }
