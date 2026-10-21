"""Measure latency on the full data and save eval/latency.json.

Run: python scripts/measure_latency.py
1. Database time: each trap-suite reference query is run 5 times on the full 1,044,848-row table.
2. End-to-end time per engine: read from the saved trap-suite runs (eval/results*.json).
   Those runs skip the final AI summary call, so in the app an AI answer takes about 1-2 s longer.
"""
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from backend import db  # noqa: E402
from backend.evaluation import ENGINES, load_results, load_suite  # noqa: E402

RUNS = 5
OUT = os.path.join(ROOT, "eval", "latency.json")


def pct(values: list[float], p: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, round(p / 100 * (len(s) - 1)))]


def main() -> None:
    queries = [t for t in load_suite() if t.get("reference_sql")]
    db_times = []
    db.execute_readonly_sql("SELECT 1")  # open the connection outside the timing
    for t in queries:
        times = []
        for _ in range(RUNS):
            t0 = time.perf_counter()
            db.execute_readonly_sql(t["reference_sql"])
            times.append((time.perf_counter() - t0) * 1000)
        db_times.append({"id": t["id"], "median_ms": round(statistics.median(times), 1), "max_ms": round(max(times), 1)})
    all_db = [x["median_ms"] for x in db_times]

    engines = []
    for mode, (label, _) in ENGINES.items():
        run = load_results(mode)
        if not run:
            continue
        lat = [r["latency_ms"] for r in run["results"] if r.get("latency_ms") is not None]
        engines.append({
            "engine": label, "tests": len(lat), "median_s": round(statistics.median(lat) / 1000, 2),
            "p90_s": round(pct(lat, 90) / 1000, 2), "max_s": round(max(lat) / 1000, 2), "run_at": run["run_at"],
        })

    out = {
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": db.get_schema()["row_count"],
        "database": {"queries": len(db_times), "runs_each": RUNS, "median_ms": round(statistics.median(all_db), 1),
                     "slowest_query_ms": max(x["max_ms"] for x in db_times), "per_query": db_times},
        "end_to_end": engines,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    print(f"Database, {out['rows']:,} rows, {len(db_times)} reference queries x {RUNS} runs: "
          f"median {out['database']['median_ms']} ms, slowest {out['database']['slowest_query_ms']} ms")
    print("| Engine | Median | 90th percentile | Slowest |")
    print("|---|---|---|---|")
    for e in engines:
        print(f"| {e['engine']} | {e['median_s']} s | {e['p90_s']} s | {e['max_s']} s |")
    print("saved", OUT)


if __name__ == "__main__":
    main()
