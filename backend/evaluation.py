"""Trap-question suite: run the agent and compare against hand-written reference SQL."""
import json
import os
from datetime import datetime, timezone

from . import db
from .agent import ask

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE_PATH = os.path.join(ROOT, "eval", "trap_suite.json")
RESULTS_PATH = os.path.join(ROOT, "eval", "results.json")
OFFLINE_RESULTS_PATH = os.path.join(ROOT, "eval", "results_offline.json")

# Engines compared on the Trap tests page. "groq" is recorded with Gemini disabled (no live mode).
ENGINES = {
    "llm": ("Gemini", "results.json"),
    "groq": ("Groq only", "results_groq.json"),
    "offline": ("Offline engine", "results_offline.json"),
    "chain": ("Full fallback chain", "results_chain.json"),
}


def results_path(mode: str) -> str:
    return os.path.join(ROOT, "eval", ENGINES.get(mode, ENGINES["llm"])[1])


def compare_engines() -> list[dict]:
    """Per-engine pass counts split by what a pass means: correct answer, asked back, refused."""
    out = []
    for mode, (label, _) in ENGINES.items():
        run = load_results(mode)
        if not run:
            continue
        res = run["results"]
        ok = lambda check: sum(r["passed"] and r["check"] == check for r in res)  # noqa: E731
        out.append({
            "mode": mode, "label": label, "run_at": run["run_at"], "total": len(res),
            "passed": sum(r["passed"] for r in res),
            "answered": ok("scalar") + ok("top_k"), "asked_back": ok("clarify"), "refused": ok("blocked"),
            "failed": sum(not r["passed"] for r in res),
            "failures": [{"id": r["id"], "reason": r["reason"]} for r in res if not r["passed"]],
            "models": sorted({r.get("model") for r in res if r.get("model")}),
        })
    return out

# Tolerance: money/counts must match to the penny (0.01) or 1e-6 relative.
ABS_TOL = 0.01
REL_TOL = 1e-6


def load_suite() -> list[dict]:
    with open(SUITE_PATH, encoding="utf-8") as f:
        return json.load(f)


def _close(a, e) -> bool:
    return abs(float(a) - float(e)) <= max(ABS_TOL, REL_TOL * abs(float(e)))


def _numbers(rows):
    return [v for r in rows for v in r if isinstance(v, (int, float)) and not isinstance(v, bool)]


def compare(test: dict, expected: dict | None, actual: dict) -> tuple[bool, str]:
    check = test["check"]
    status = actual.get("status")
    if check == "clarify":
        return (status == "clarification", "asked a clarifying question" if status == "clarification"
                else f"did not ask back (status={status})")
    if check == "blocked":
        ok = status in ("refused", "blocked")
        return ok, "request refused, no data modified" if ok else f"not refused (status={status})"
    if status != "success":
        return False, f"agent status '{status}': {actual.get('answer', '')[:160]}"

    rows = actual.get("rows", [])
    if check == "scalar":
        exp_nums = _numbers(expected["rows"][:1])
        act_nums = _numbers(rows[:5])
        missing = [e for e in exp_nums if not any(_close(a, e) for a in act_nums)]
        if missing:
            return False, f"expected {exp_nums}, got {act_nums[:6]}"
        return True, f"matched {exp_nums}"
    if check == "top_k":
        ref_keys = [str(r[0]) for r in expected["rows"]]
        k = min(len(ref_keys), len(rows))
        if k == 0:
            return False, "no rows returned"
        got = []
        for r in rows[:k]:
            cells = {str(v).strip() for v in r}
            got.append(next((key for key in ref_keys if key in cells), None))
        if set(got) == set(ref_keys[:k]):
            return True, f"top {k} match: {ref_keys[:k]}"
        return False, f"expected top {k} {ref_keys[:k]}, got rows {[r[:2] for r in rows[:k]]}"
    return False, f"unknown check {check}"


def run_test(test: dict, mode: str = "llm") -> dict:
    expected = db.execute_readonly_sql(test["reference_sql"]) if test.get("reference_sql") else None
    # Saved answers are bypassed so the suite always tests the engine itself.
    # "chain" is the app's real path (Gemini, then Groq, then offline) minus saved answers.
    actual = ask(test["question"], summarize=False, mode="auto" if mode == "chain" else mode, use_cache=False)
    passed, reason = compare(test, expected, actual)
    return {
        "id": test["id"], "question": test["question"], "category": test["category"], "check": test["check"],
        "challenge": test.get("challenge"), "passed": passed, "reason": reason,
        "reference_sql": test.get("reference_sql"),
        "expected": {"columns": expected["columns"], "rows": expected["rows"][:10]} if expected else None,
        "agent_status": actual.get("status"), "agent_sql": actual.get("sql"),
        "agent_answer": actual.get("answer"),
        "actual": {"columns": actual.get("columns", []), "rows": actual.get("rows", [])[:10]},
        "attempts": actual.get("attempts"), "latency_ms": actual.get("latency_ms"), "model": actual.get("model"), "source": actual.get("source"),
    }


def summarise_run(results: list[dict], mode: str = "llm") -> dict:
    amb = [r for r in results if r["check"] == "clarify"]
    return {
        "mode": mode,
        "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total": len(results),
        "passed": sum(r["passed"] for r in results),
        "execution_accuracy": round(sum(r["passed"] for r in results) / len(results), 3) if results else 0,
        "clarification_rate": round(sum(r["passed"] for r in amb) / len(amb), 3) if amb else None,
        "results": results,
    }


def run_suite(ids: list[str] | None = None, mode: str = "llm") -> dict:
    tests = [t for t in load_suite() if not ids or t["id"] in ids]
    return summarise_run([run_test(t, mode) for t in tests], mode)


def load_results(mode: str = "llm") -> dict | None:
    path = results_path(mode)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)
