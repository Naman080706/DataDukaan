"""Run the trap-question suite locally and save eval/results.json.

Run: python scripts/run_eval.py [T01 T02 ...]
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(ROOT, ".env"))

from backend.evaluation import RESULTS_PATH, run_suite  # noqa: E402

if __name__ == "__main__":
    summary = run_suite(sys.argv[1:] or None)
    for r in summary["results"]:
        print(f"{r['id']} {'PASS' if r['passed'] else 'FAIL'}  {r['question'][:55]:55}  {r['reason'][:90]}")
    print(f"\n{summary['passed']}/{summary['total']} passed, clarification rate {summary['clarification_rate']}")
    if not sys.argv[1:]:
        with open(RESULTS_PATH, "w", encoding="utf-8") as f:
            json.dump(summary, f, indent=2, default=str)
        print("saved", RESULTS_PATH)
