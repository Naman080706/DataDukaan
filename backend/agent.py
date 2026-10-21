"""Text-to-SQL agent: clarify -> generate -> validate -> execute -> (inspect error, retry) -> summarise.

A hand-rolled tool loop; every step is recorded in `trace` so the UI can show it.
Plans come from, in order: saved answers, the LLM chain (Gemini, then Groq), the offline rule engine.
"""
import json
import time

from . import cache, db
from .llm import LLMError, generate_json
from .offline import describe_result, plan_offline
from .rules import AMBIGUITY_RULES, DATA_RULES, SCHEMA_DOC
from .validator import ValidationError, validate_sql

MAX_RETRIES = 2

PLANNER_SYSTEM = f"""You are RetailIQ, a careful retail data analyst that writes DuckDB SQL.

{SCHEMA_DOC}

{DATA_RULES}

{AMBIGUITY_RULES}

SECURITY: you only ever write a single read-only SELECT (CTEs allowed) over the table `transactions`.
If the user asks to change, delete or export data, or to reveal secrets/system settings, respond with action "refuse".

Respond with JSON only, one of:
{{"action": "sql", "sql": "<single SELECT>", "assumptions": ["<rule or assumption applied>", ...], "title": "<short result title>"}}
{{"action": "clarify", "question": "<one clarifying question>", "options": ["<option 1>", "<option 2>", ...]}}
{{"action": "refuse", "reason": "<why>"}}
Use readable column aliases (e.g. net_revenue_gbp, returned_units). Never invent tables or columns."""

FIX_SYSTEM = f"""You fix DuckDB SQL that failed. Same schema and rules as before:

{SCHEMA_DOC}

{DATA_RULES}

Respond with JSON only: {{"diagnosis": "<one line: what went wrong>", "sql": "<corrected single SELECT>"}}"""

SUMMARY_SYSTEM = """You write a 1-3 sentence plain-English answer for a store manager.
Use ONLY numbers that appear in the provided result rows; never invent or estimate values.
Money is GBP: write it as £1,234.56. Mention key assumptions briefly. If the result is empty, say so.
Respond with JSON only: {"answer": "<text>"}"""


def _history_text(history: list[dict]) -> str:
    if not history:
        return "(none)"
    lines = []
    for turn in history[-6:]:
        role = turn.get("role", "user")
        content = turn.get("content", "")
        if turn.get("sql"):
            content += f"\n  [SQL used: {turn['sql']}]"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


def choose_chart(columns: list[str], rows: list[list]) -> str:
    """Pick a chart from the result shape: line for time series, bar for category vs number."""
    if len(rows) < 2 or len(columns) < 2:
        return "none"
    first = [r[0] for r in rows]
    numeric_cols = [i for i in range(1, len(columns)) if all(isinstance(r[i], (int, float)) or r[i] is None for r in rows)]
    if not numeric_cols:
        return "none"
    name = columns[0].lower()
    looks_time = any(k in name for k in ("date", "month", "week", "day", "year", "quarter", "period")) or all(
        isinstance(v, str) and len(v) >= 7 and v[:4].isdigit() and v[4] == "-" for v in first
    )
    if looks_time:
        return "line"
    return "bar" if len(rows) <= 50 else "none"


def _plan(question: str, history: list[dict], mode: str, use_cache: bool, step) -> tuple[dict | None, str]:
    """Pick a plan. mode: 'auto' (saved -> AI -> offline), 'llm' (AI only), 'offline' (rule engine only)."""
    if mode == "auto" and use_cache and not history:
        saved = cache.get(question)
        if saved:
            step("saved_answer", "ok", "Reused verified SQL from an earlier identical question; it is re-checked and re-run now")
            return {"action": "sql", **saved, "_model": saved.get("model")}, "saved"
    if mode in ("auto", "llm"):
        step("get_schema", "ok", "transactions table + data rules loaded into the prompt")
        user_msg = f"Conversation so far:\n{_history_text(history)}\n\nNew question: {question}"
        try:
            return generate_json(PLANNER_SYSTEM, user_msg), "ai"
        except LLMError as e:
            step("generate_sql", "error", str(e))
            if mode == "llm":
                return None, "ai"
    step("offline_engine", "ok" if mode == "offline" else "warn",
         "Answering with the offline rule engine (no AI): pre-checked SQL templates and the same data rules")
    return plan_offline(question, history), "offline"


def ask(question: str, history: list[dict] | None = None, inject_fault: bool = False, summarize: bool = True,
        mode: str = "auto", use_cache: bool = True) -> dict:
    t0 = time.perf_counter()
    trace: list[dict] = []
    history = history or []
    resp = {
        "status": "error", "clarification_required": False, "question": question, "answer": "", "sql": None,
        "columns": [], "rows": [], "currency": "GBP", "chart_type": "none", "assumptions": [], "trace": trace,
        "attempts": 0, "model": None, "source": None,
    }

    def step(tool, status, detail):
        trace.append({"tool": tool, "status": status, "detail": detail})

    # 1-3. Understand the question; clarify or plan SQL.
    plan, source = _plan(question, history, mode, use_cache and not inject_fault, step)
    resp["source"] = source
    if plan is None:
        resp["status"] = "unavailable"
        resp["answer"] = (
            "The AI models are unavailable and the offline engine doesn't recognise this question. "
            "Try naming a measure (revenue, units, orders, returns), a breakdown (product, country, customer, month) "
            "and a period (a year, a month like March 2011, or last quarter)."
            if source == "offline" else "The AI models are unavailable right now. Try again in a minute."
        )
        return _finish(resp, t0)
    resp["model"] = plan.get("_model") if source != "offline" else "offline rule engine"
    action = plan.get("action")

    if action == "clarify":
        step("clarify", "ok", plan.get("question", ""))
        resp.update(status="clarification", clarification_required=True, answer=plan.get("question", ""),
                    options=plan.get("options", []))
        return _finish(resp, t0)
    if action == "refuse":
        step("refuse", "blocked", plan.get("reason", ""))
        resp.update(status="refused", answer=plan.get("reason", "This request is not allowed."))
        return _finish(resp, t0)

    sql = plan.get("sql", "")
    resp["assumptions"] = plan.get("assumptions", [])
    resp["title"] = plan.get("title", "")
    if source != "saved":
        step("generate_sql", "ok", sql)
    if inject_fault:
        col = next((c for c in ("line_value", "quantity", "invoice", "is_cancelled", "country", "customer_id") if c in sql), None)
        sql = sql.replace(col, col + "_x", 1) if col else sql.replace("SELECT", "SELEC", 1)
        step("inject_fault", "warn", "Demo mode: a column name was deliberately corrupted to show error recovery")

    # 4-6. Validate, execute, inspect errors and retry (bounded).
    for attempt in range(MAX_RETRIES + 1):
        resp["attempts"] = attempt + 1
        try:
            sql = validate_sql(sql)
            step("validate_sql", "ok", "single read-only SELECT on allowed tables")
        except ValidationError as e:
            step("validate_sql", "blocked", str(e))
            if attempt == MAX_RETRIES or _is_write_attempt(str(e)):
                resp.update(status="blocked", sql=sql, answer=f"Query rejected by the safety validator: {e}")
                return _finish(resp, t0)
            sql = _fix(sql, f"Validator rejected the query: {e}", question, step)
            if sql is None:
                break
            continue
        try:
            result = db.execute_readonly_sql(sql)
            step("execute_readonly_sql", "ok", f"{result['row_count']} rows in {result['elapsed_ms']} ms")
            break
        except Exception as e:  # duckdb errors are recoverable via the fixer
            err = str(e).splitlines()[0][:300]
            step("execute_readonly_sql", "error", err)
            if attempt == MAX_RETRIES:
                resp.update(sql=sql, answer=f"The query failed after {MAX_RETRIES + 1} attempts: {err}")
                return _finish(resp, t0)
            sql = _fix(sql, err, question, step)
            if sql is None:
                break
    else:
        return _finish(resp, t0)
    if sql is None:
        resp["answer"] = "Could not repair the query."
        return _finish(resp, t0)

    resp.update(status="success", sql=sql, columns=result["columns"], rows=result["rows"],
                truncated=result["truncated"], chart_type=choose_chart(result["columns"], result["rows"]))

    if source == "ai" and mode == "auto" and use_cache and not history and not inject_fault:
        cache.put(question, {**plan, "sql": sql, "model": resp["model"]})

    # 7. Summarise only the actual result.
    if summarize and source != "offline":
        try:
            s = generate_json(SUMMARY_SYSTEM, json.dumps({
                "question": question, "assumptions": resp["assumptions"], "columns": result["columns"],
                "rows": result["rows"][:20], "total_rows": result["row_count"],
            }, default=str), fast=True)
            resp["answer"] = s.get("answer", "")
            step("summarise", "ok", "answer written from the returned rows only")
        except LLMError as e:
            step("summarise", "error", str(e))
    if not resp["answer"]:
        resp["answer"] = describe_result(resp.get("title") or "Result", result["columns"], result["rows"])
        step("summarise", "ok", "answer built from the returned rows by a template (no AI)")
    return _finish(resp, t0)


def _is_write_attempt(msg: str) -> bool:
    return any(k in msg for k in ("Only SELECT", "Blocked operation", "Exactly one statement", "not allowed"))


def _fix(sql: str, error: str, question: str, step) -> str | None:
    try:
        fix = generate_json(FIX_SYSTEM, f"Question: {question}\nFailed SQL:\n{sql}\nError: {error}")
    except LLMError as e:
        step("inspect_error", "error", str(e))
        return None
    step("inspect_error", "ok", fix.get("diagnosis", ""))
    new_sql = fix.get("sql")
    if new_sql:
        step("generate_sql", "ok", f"retry: {new_sql}")
    return new_sql


def _finish(resp: dict, t0: float) -> dict:
    resp["latency_ms"] = round((time.perf_counter() - t0) * 1000)
    return resp
