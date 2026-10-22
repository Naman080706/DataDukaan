"""Agent steps for a user's own dataset, which lives in their browser (DuckDB-WASM), not on the server.

The browser runs the loop: plan here -> run the SQL locally -> on error ask fix() here -> run again -> summarise() here.
The server only sees the table's column names, a few sample rows and the result rows; it never gets the file.
Each step reuses the same prompts, validator and backup engine as the built-in dataset.
"""
import json

from .agent import _history_text, choose_chart, fix_system, planner_system, summary_system
from .llm import LLMError, generate_json
from .offline import Ctx, describe_result, plan_offline
from .rules import generic_rules, periods, retail_rules
from .validator import ValidationError, validate_sql

MAX_SAMPLE_ROWS = 5
MAX_RESULT_ROWS = 20


def _context(ds: dict) -> dict:
    """Prompt pieces for this dataset: retail rules if it was mapped to the retail layout, generic otherwise."""
    source = str(ds.get("source") or "uploaded file")[:120]
    dr = ds.get("date_range") or [None, None]
    if ds.get("kind") == "retail" and dr[0] and dr[1]:
        r = retail_rules(str(dr[0]), str(dr[1]), money="the dataset's own currency (not stated; use no currency symbol)",
                         money_suffix="value", source=f'the user\'s uploaded file "{source}"')
        year = r["periods"]["this_year"]
        return {
            "table": "transactions", "retail": True, "periods": r["periods"],
            "planner": planner_system(r["schema"], r["rules"], r["ambiguity"], year=year, money_alias="net_revenue_value"),
            "fix": fix_system(r["schema"], r["rules"]),
        }
    table = "dataset"
    r = generic_rules(table, ds.get("columns", [])[:80], ds.get("sample_rows", [])[:MAX_SAMPLE_ROWS],
                      int(ds.get("row_count") or 0), dr if dr[1] else None, source)
    year = periods(str(dr[1]))["this_year"] if dr[1] else 2024
    return {
        "table": table, "retail": False, "periods": None,
        "planner": planner_system(r["schema"], r["rules"], r["ambiguity"], table=table, year=year,
                                  money_alias="total_value", analyst="a careful data analyst"),
        "fix": fix_system(r["schema"], r["rules"]),
    }


def plan(question: str, history: list[dict], ds: dict, mode: str = "auto") -> dict:
    """Decide: clarify, refuse, or validated SQL to run in the browser. Returns the plan plus its trace steps."""
    ctx = _context(ds)
    trace: list[dict] = []
    step = lambda tool, status, detail: trace.append({"tool": tool, "status": status, "detail": detail})  # noqa: E731
    offline_ctx = Ctx(periods=ctx["periods"], countries=ds.get("countries") or [], execute=None) if ctx["retail"] else None
    source, result = "ai", None

    if mode != "offline":
        step("get_schema", "ok", f"your table's columns and {'the retail counting rules' if ctx['retail'] else 'a few sample rows'}")
        user_msg = f"Conversation so far:\n{_history_text(history)}\n\nNew question: {question}"
        try:
            result = generate_json(ctx["planner"], user_msg)
            if result.get("action") == "clarify" and offline_ctx:
                result = _check_ask_back_ctx(question, history, user_msg, result, step, ctx, offline_ctx)
        except LLMError as e:
            step("generate_sql", "error", str(e))
    if result is None:
        source = "offline"
        if not offline_ctx:
            return {"status": "unavailable", "trace": trace, "source": source,
                    "answer": "The AI service is busy, and backup mode only works for sales data with invoices, products, "
                              "quantities and prices. Try again in a minute."}
        step("offline_engine", "ok" if mode == "offline" else "warn", "Answering in backup mode (no AI)")
        result = plan_offline(question, history, offline_ctx)
        if result is None:
            return {"status": "unavailable", "trace": trace, "source": source,
                    "answer": "Backup mode doesn't recognise this question. Try saying what to count (revenue, units, "
                              "orders or returns), how to split it (by product, country, customer or month) and when."}

    action = result.get("action")
    model = result.get("_model") if source == "ai" else "offline rule engine"
    if action == "clarify":
        step("clarify", "ok", result.get("question", ""))
        return {"status": "clarification", "answer": result.get("question", ""), "options": result.get("options", []),
                "trace": trace, "source": source, "model": model}
    if action == "refuse":
        step("refuse", "blocked", result.get("reason", ""))
        return {"status": "refused", "answer": result.get("reason", "This request is not allowed."), "trace": trace,
                "source": source, "model": model}

    if result.get("steps") and len(result["steps"]) > 1:
        step("plan_steps", "ok", " → ".join(str(x) for x in result["steps"]))
    sql = result.get("sql", "")
    step("generate_sql", "ok", sql)
    try:
        sql = validate_sql(sql, {ctx["table"]})
        step("validate_sql", "ok", "single read-only SELECT on your table")
    except ValidationError as e:
        step("validate_sql", "blocked", str(e))
        fixed = fix(question, sql, f"Validator rejected the query: {e}", ds)
        trace += fixed.pop("trace")
        if fixed.get("status") != "run":
            return {**fixed, "trace": trace, "source": source, "model": model}
        sql = fixed["sql"]
    return {"status": "run", "sql": sql, "assumptions": result.get("assumptions", []), "title": result.get("title", ""),
            "trace": trace, "source": source, "model": model}


def _check_ask_back_ctx(question, history, user_msg, plan_, step, ctx, offline_ctx):
    """Same unneeded-ask-back guard as the built-in agent, using this dataset's rules."""
    rules_plan = plan_offline(question, history, offline_ctx)
    if not rules_plan or rules_plan.get("action") != "sql":
        return plan_
    step("clarify_check", "warn", f"The model asked “{plan_.get('question', '')}”, but the counting rules already define "
                                  f"this: {rules_plan['title']}.")
    hint = (f"{user_msg}\n\nThe data rules already answer the wording of this question, so do NOT ask a clarifying "
            f"question. It means: {rules_plan['title']}. Respond with action \"sql\".")
    retry = generate_json(ctx["planner"], hint)
    return retry if retry.get("action") == "sql" else plan_


def fix(question: str, sql: str, error: str, ds: dict) -> dict:
    """The browser's run failed: ask the model for corrected SQL and validate it."""
    ctx = _context(ds)
    trace: list[dict] = [{"tool": "execute_readonly_sql", "status": "error", "detail": error[:300]}]
    try:
        out = generate_json(ctx["fix"], f"Question: {question}\nFailed SQL:\n{sql}\nError: {error[:500]}")
    except LLMError as e:
        trace.append({"tool": "inspect_error", "status": "error", "detail": str(e)})
        return {"status": "error", "trace": trace, "answer": "DataDukaan couldn't work this out. Try asking it a different way."}
    trace.append({"tool": "inspect_error", "status": "ok", "detail": out.get("diagnosis", "")})
    try:
        new_sql = validate_sql(out.get("sql", ""), {ctx["table"]})
    except ValidationError as e:
        trace.append({"tool": "validate_sql", "status": "blocked", "detail": str(e)})
        return {"status": "blocked", "trace": trace,
                "answer": "This was blocked for safety: DataDukaan can only look at your data, never change it."}
    trace.append({"tool": "generate_sql", "status": "ok", "detail": f"retry: {new_sql}"})
    trace.append({"tool": "validate_sql", "status": "ok", "detail": "single read-only SELECT on your table"})
    return {"status": "run", "sql": new_sql, "trace": trace}


def summarise(question: str, title: str, assumptions: list[str], columns: list[str], rows: list[list], source: str) -> dict:
    """Plain-English answer from the rows the browser got back, plus the chart type."""
    rows = rows[:MAX_RESULT_ROWS]
    chart = choose_chart(columns, rows)
    if source != "offline":
        try:
            s = generate_json(summary_system("Money: the currency isn't stated, so write amounts like 1,234.56 with no symbol."),
                              json.dumps({"question": question, "assumptions": assumptions, "columns": columns,
                                          "rows": rows, "total_rows": len(rows)}, default=str), fast=True)
            if s.get("answer"):
                return {"answer": s["answer"], "chart_type": chart, "summary_by": "ai"}
        except LLMError:
            pass
    return {"answer": describe_result(title or "Result", columns, rows).replace("£", ""), "chart_type": chart,
            "summary_by": "template"}
