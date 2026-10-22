"""Draw the engine comparison chart from the saved trap-suite runs into docs/engine_comparison.png.

Run: python scripts/make_chart.py   (needs matplotlib)
Reads eval/results*.json; nothing is re-run.
"""
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import matplotlib  # noqa: E402

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from backend.evaluation import compare_engines  # noqa: E402

OUT = os.path.join(ROOT, "docs", "engine_comparison.png")
SEGMENTS = [
    ("answered", "Correct answer", "#00735A"),
    ("asked_then_answered", "Asked back, then answered", "#B2E1D6"),
    ("asked_back", "Rightly asked back", "#C8B273"),
    ("refused", "Rightly refused", "#A8A28F"),
    ("failed", "Failed", "#B8322A"),
]
INK, MUTED, RULE, PAPER = "#1D2521", "#6B6F66", "#DED0AB", "#FFFFFF"


def main() -> None:
    scores = compare_engines()
    if not scores:
        sys.exit("No saved runs in eval/. Run scripts/run_eval.py first.")
    scores = scores[::-1]  # first engine at the top
    total = max(s["total"] for s in scores)
    labels = [s["label"] for s in scores]

    fig, ax = plt.subplots(figsize=(10, 1.0 * len(scores) + 2.2), dpi=200)
    fig.patch.set_facecolor(PAPER)
    ax.set_facecolor(PAPER)

    left = [0] * len(scores)
    for key, name, color in SEGMENTS:
        vals = [s[key] for s in scores]
        ax.barh(labels, vals, left=left, color=color, height=0.55, label=name, edgecolor=PAPER, linewidth=1)
        left = [a + b for a, b in zip(left, vals)]

    for i, s in enumerate(scores):
        ax.text(total + 0.25, i, f"{s['passed']}/{s['total']}", va="center", ha="left", fontsize=14, fontweight="bold", color=INK)

    ax.set_xlim(0, total + 1.6)
    ax.set_xticks([0, 5, 10, total])
    ax.tick_params(axis="x", colors=MUTED, labelsize=10, length=0)
    ax.tick_params(axis="y", colors=INK, labelsize=12, length=0)
    ax.grid(axis="x", color=RULE, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "bottom"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(INK)

    run_date = datetime.fromisoformat(max(s["run_at"] for s in scores)).astimezone().strftime("%d %b %Y")
    fig.text(0.02, 0.955, "Which engine gets the trap questions right", ha="left", va="top", fontsize=17, fontweight="bold", color=INK)
    fig.text(0.02, 0.885, f"DataDukaan: the same {total} trap questions, scored against hand-written SQL. Runs saved {run_date}.",
             ha="left", va="top", fontsize=10, color=MUTED)
    ax.legend(loc="upper center", bbox_to_anchor=(0.45, -0.14), ncol=5, frameon=False, fontsize=9.5, columnspacing=1.4, labelcolor=INK)

    notes = []
    for s in scores[::-1]:
        for f in s["failures"]:
            reason = f["reason"].split(":")[0] if "unavailable" in f["reason"] else f["reason"]
            notes.append(f"{s['label']} {f['id']}: {'AI quota error, every model rate-limited' if 'unavailable' in f['reason'] else reason}")
    notes.append("Offline engine was written with these questions in view.")
    fig.text(0.02, 0.015, "Notes: " + "  |  ".join(notes), fontsize=8.5, color=MUTED, ha="left")

    fig.tight_layout(rect=(0, 0.04, 1, 0.86))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fig.savefig(OUT, facecolor=PAPER)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
