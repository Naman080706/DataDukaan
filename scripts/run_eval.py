"""Run the trap-question suite locally and save eval/results.json.

Run: python scripts/run_eval.py [--offline] [--answers] [T01 T02 ...]
--offline scores the rule engine alone (no AI) and saves eval/results_offline.json.
--chain scores the full fallback chain (Gemini, then Groq, then offline) and saves eval/results_chain.json.
--answers also writes each answer and claim-checks it (one more AI call per test).
--claims runs the planted-error claim suite (no AI). --learning [--offline] runs the correction-memory suite.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(ROOT, ".env"))

from backend.evaluation import learning_results_path, results_path, run_claim_suite, run_learning_suite, run_suite  # noqa: E402


def learning(mode: str) -> None:
    """--learning: teach each correction, then score repeat/paraphrase/control probes before and after."""
    run = run_learning_suite(None, mode)
    for sc in run["scenarios"]:
        for p in sc["probes"]:
            b, a = p["before"]["passed"], p["after"]["passed"]
            print(f"{sc['id']} {p['role']:10} {'PASS' if b else 'fail'} -> {'PASS' if a else 'fail'}  {p['question']}")
    print(f"\nlearned probes: {run['learn_before']}/{run['learn_total']} before, {run['learn_after']}/{run['learn_total']} after; "
          f"controls: {run['control_before']}/{run['control_total']} before, {run['control_after']}/{run['control_total']} after")
    with open(learning_results_path(mode), "w", encoding="utf-8") as f:
        json.dump(run, f, indent=2, default=str)
    print("saved", learning_results_path(mode))


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--learning" in args:
        learning("offline" if "--offline" in args else "llm")
        sys.exit()
    if "--claims" in args:
        run = run_claim_suite()
        for r in run["results"]:
            print(f"{r['id']} {'PASS' if r['passed'] else 'FAIL'}  {r['planted']:45} -> {r['got']['status']} {r['got']['categories']}")
        print(f"\ncaught {run['caught']}/{run['planted']} planted errors, {run['false_alarms']} false alarms")
        sys.exit()
    mode = "offline" if "--offline" in args else "chain" if "--chain" in args else "llm"
    ids = [a for a in args if not a.startswith("--")]
    summary = run_suite(ids or None, mode, check_answers="--answers" in args)
    for r in summary["results"]:
        print(f"{r['id']} {'PASS' if r['passed'] else 'FAIL'}  {r['question'][:55]:55}  {r['reason'][:90]}"
              + (f"  [{r['failure_label']}]" if r.get("failure_label") else ""))
    print(f"\n{summary['passed']}/{summary['total']} passed, clarification rate {summary['clarification_rate']}")
    if not ids:
        with open(results_path(mode), "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)
        print("saved", results_path(mode))
