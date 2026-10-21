"""Run the trap-question suite locally and save eval/results.json.

Run: python scripts/run_eval.py [--offline] [T01 T02 ...]
--offline scores the rule engine alone (no AI) and saves eval/results_offline.json.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(ROOT, ".env"))

from backend.evaluation import results_path, run_suite  # noqa: E402

if __name__ == "__main__":
    args = sys.argv[1:]
    mode = "offline" if "--offline" in args else "llm"
    ids = [a for a in args if not a.startswith("--")]
    summary = run_suite(ids or None, mode)
    for r in summary["results"]:
        print(f"{r['id']} {'PASS' if r['passed'] else 'FAIL'}  {r['question'][:55]:55}  {r['reason'][:90]}")
    print(f"\n{summary['passed']}/{summary['total']} passed, clarification rate {summary['clarification_rate']}")
    if not ids:
        with open(results_path(mode), "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)
        print("saved", results_path(mode))
