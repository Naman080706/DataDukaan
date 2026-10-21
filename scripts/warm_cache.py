"""Pre-save verified SQL for the app's suggested questions into data/saved_answers.json.

Run: python scripts/warm_cache.py
Each question goes through the AI agent once; only successful plans are saved.
Review the printed SQL before committing the file.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(ROOT, ".env"))

from backend import cache  # noqa: E402
from backend.agent import ask  # noqa: E402

QUESTIONS = [
    "What were the top 5 products by revenue?",
    "What was our revenue excluding cancelled invoices?",
    "Which products were returned most last quarter?",
    "Show monthly net revenue in 2011",
    "Which country generated the highest net revenue?",
    "Which customers generated the most revenue?",
    "How many invoices were cancelled?",
    "What was our net sales revenue in 2011?",
]

if __name__ == "__main__":
    for q in QUESTIONS:
        r = ask(q, mode="llm", summarize=False)
        if r["status"] == "success":
            cache.put(q, {"sql": r["sql"], "assumptions": r["assumptions"], "title": r.get("title"), "model": r["model"]})
            print(f"saved  {q}\n       {r['sql']}\n")
        else:
            print(f"SKIP   {q} ({r['status']}: {r['answer'][:80]})")
    cache.save_seed()
    print("wrote", cache.SEED_PATH)
