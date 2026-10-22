"""Correction memory: what the user taught DataDukaan with "That's not quite right", and when it applies.

A correction records the question, the original SQL, the corrected SQL, the corrected business rule (as a
structured override plus a plain-English sentence) and the user's own reason. Corrections are kept in the
browser per user (like history) and sent with each question; this module only decides which apply:
  - retrieval: similarity between questions after masking literals (years, months, countries, numbers), plus
    the measure / breakdown each question is about
  - applicability: each correction type has a narrow rule (a "sales" lesson doesn't touch "net revenue")
Applied corrections become few-shot lessons for the AI and overrides for the offline engine, and an
identical question reuses the corrected SQL directly (re-validated and re-run).
"""
import re

from .cache import normalise
from .offline import MEASURES, MONTHS, _known_countries

TYPES = {
    "wrong_metric": "Wrong metric definition",
    "wrong_period": "Wrong filter or period",
    "wrong_grouping": "Wrong grouping",
    "missing_exclusion": "Missing exclusion rule",
}
LAST_12_MONTHS = {"start": "2010-12-01", "end": "2011-12-01", "label": "the last 12 complete months (Dec 2010 to Nov 2011)"}
# What the user can pick for each type: key -> (label shown, override, sentence for the learned rule).
CHOICES = {
    "wrong_metric": {k: (MEASURES[k][3][0].upper() + MEASURES[k][3][1:], {"measure": k}, f"count {MEASURES[k][3]}") for k in MEASURES},
    "wrong_period": {
        **{str(y): (str(y), {"period": {"start": f"{y}-01-01", "end": f"{y + 1}-01-01", "label": str(y)}}, f"use {y}")
           for y in (2010, 2011)},
        **{f"q{q}-2011": (f"Q{q} 2011", {"period": {"start": f"2011-{3 * q - 2:02d}-01",
                                                    "end": f"2011-{3 * q + 1:02d}-01" if q < 4 else "2012-01-01",
                                                    "label": f"Q{q} 2011"}}, f"use Q{q} 2011") for q in (1, 2, 3, 4)},
        "last-12": ("The last 12 complete months", {"period": LAST_12_MONTHS}, f"use {LAST_12_MONTHS['label']}"),
        "all": ("All dates (Dec 2009 to Dec 2011)", {"period": {"start": "2009-12-01", "end": "2012-01-01", "label": "all dates"}},
                "use all dates"),
    },
    "wrong_grouping": {
        **{d: (f"By {d}", {"dim": d}, f"break it down by {d}") for d in ("product", "country", "customer", "month", "quarter", "year")},
        "none": ("One total (no breakdown)", {"dim": "none"}, "give one total, with no breakdown"),
    },
    "missing_exclusion": {
        "uk": ("Leave out the United Kingdom", {"exclude": ["uk"]}, "leave out the United Kingdom"),
        "non_products": ("Products only (no postage or fees)", {"exclude": ["non_products"]}, "count products only, not postage or fees"),
        "unknown_customers": ("Only customers with an ID", {"exclude": ["unknown_customers"]}, "leave out sales without a customer ID"),
    },
}
METRIC_TERMS = ["sales", "revenue", "turnover", "takings", "income", "best-selling", "best selling", "popular", "sold", "returns"]
PERIOD_TERMS = ["this year", "last year", "recently", "recent", "last 12 months", "past year", "this quarter", "last quarter"]
EXPLICIT_MEASURE = re.compile(r"\b(net|gross|excluding cancel\w*|units?|quantity|orders|invoices|customers|returned units|return invoices)\b")
EXPLICIT_DIM = re.compile(r"\b(by|per|each)\s+(product|country|customer|month|quarter|year)s?\b|\b(monthly|quarterly|yearly|annual)\b")
STOP = set("a an the of in for on to by and or what was were is are did do does we our us me my show give tell how which who "
           "it its that this with from at be been much many".split())
SLOT_METRIC = [("revenue", r"revenue|sales|turnover|takings|income|spend|spent|value|money|earn"), ("units", r"units|quantity|sold|selling|volume"),
               ("orders", r"orders|invoices|purchases"), ("returns", r"return|refund"), ("customers", r"how many (?:\w+ )?customers")]
SLOT_DIM = [("product", r"products?|items?|skus?|stock codes?"), ("country", r"countr\w*|markets?"),
            ("customer", r"(?<!many )(?<!unique )customers?(?! made| bought| purchased)"), ("month", r"monthly|months?\b"),
            ("quarter", r"quarterly|by quarter"), ("year", r"yearly|annual|by year")]


def _stem(w: str) -> str:
    for suf, rep in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: len(w) - len(suf)] + rep
    return w


def masked_tokens(question: str) -> set[str]:
    q = question.lower().replace("’", "'")
    for c in _known_countries():
        q = re.sub(r"\b" + re.escape(c.lower()) + r"\b", " <country> ", q)
    q = re.sub(r"\b(?:" + "|".join(MONTHS) + r")\b", " <month> ", q)
    q = re.sub(r"\bq[1-4]\b", " <quarter> ", q)
    q = re.sub(r"\b20\d\d\b", " <year> ", q)
    q = re.sub(r"\b\d+\b", " <n> ", q)
    words = re.findall(r"<\w+>|[a-z][a-z'-]+", q)
    return {w if w.startswith("<") else _stem(w) for w in words if w not in STOP}


def slots(question: str) -> tuple[str | None, str | None]:
    q = question.lower()
    metric = next((name for name, rx in SLOT_METRIC if re.search(r"\b(?:" + rx + r")", q)), None)
    dim = next((name for name, rx in SLOT_DIM if re.search(r"\b(?:" + rx + r")", q)), None)
    return metric, dim


def similarity(a: str, b: str) -> float:
    ta, tb = masked_tokens(a), masked_tokens(b)
    if ta == tb:
        return 1.0
    jac = len(ta & tb) / len(ta | tb) if ta | tb else 0.0
    (ma, da), (mb, db) = slots(a), slots(b)
    return round(0.6 * jac + 0.2 * (ma == mb) + 0.2 * (da == db), 3)


def detect_term(kind: str, question: str) -> str | None:
    q = question.lower()
    terms = METRIC_TERMS if kind == "wrong_metric" else PERIOD_TERMS if kind == "wrong_period" else []
    return next((t for t in terms if re.search(r"\b" + re.escape(t) + r"\b", q)), None)


def applies(c: dict, question: str, score: float) -> bool:
    """Narrow, per-type rules for when a past correction should change a new question."""
    q = question.lower()
    term = c.get("term")
    if score >= 0.999:
        return True
    if c["type"] == "wrong_metric":
        return bool(term) and re.search(r"\b" + re.escape(term) + r"\b", q) is not None and not EXPLICIT_MEASURE.search(q) and score >= 0.3
    if c["type"] == "wrong_period":
        if term:
            return re.search(r"\b" + re.escape(term) + r"\b", q) is not None
        return score >= 0.6
    if c["type"] == "wrong_grouping":
        return score >= 0.6 and not EXPLICIT_DIM.search(q) and slots(q)[0] == slots(c["question"])[0]
    if c["type"] == "missing_exclusion":
        return score >= 0.45 and slots(q)[1] == slots(c["question"])[1]
    return score >= 0.6


def retrieve(question: str, corrections: list[dict], k: int = 3) -> list[dict]:
    """The past corrections that apply to this question, best first, each with its similarity score."""
    scored = []
    for c in corrections or []:
        if not c.get("enabled", True):
            continue
        score = similarity(question, c["question"])
        if applies(c, question, score):
            scored.append({**c, "score": score})
    scored.sort(key=lambda c: c["score"], reverse=True)
    # One lesson per type: the closest one wins (two metric overrides can't both apply).
    out, seen = [], set()
    for c in scored:
        if c["type"] not in seen:
            out.append(c)
            seen.add(c["type"])
    return out[:k]


def exact_match(question: str, matches: list[dict]) -> dict | None:
    """The same question word for word (years and names included), so its corrected SQL can be reused as is."""
    return next((c for c in matches if c.get("corrected_sql") and normalise(c["question"]) == normalise(question)), None)


def merged_override(matches: list[dict]) -> dict:
    out: dict = {}
    for c in matches:
        for key, val in (c.get("override") or {}).items():
            if key == "exclude":
                out["exclude"] = sorted(set(out.get("exclude", [])) | set(val))
            else:
                out.setdefault(key, val)
    return out


def prompt_block(matches: list[dict]) -> str:
    """Few-shot lessons for the planner prompt."""
    if not matches:
        return ""
    lines = ["LESSONS FROM THIS USER'S PAST CORRECTIONS (they override the default rules where they apply; follow them):"]
    for i, c in enumerate(matches, 1):
        lines.append(f"{i}. Earlier question: {c['question']}\n   What was wrong ({TYPES.get(c['type'], 'other')}): {c['rule']}"
                     + (f"\n   The user's words: {c['rationale']}" if c.get("rationale") else "")
                     + (f"\n   Original SQL: {c['original_sql']}" if c.get("original_sql") else "")
                     + (f"\n   Corrected SQL: {c['corrected_sql']}" if c.get("corrected_sql") else ""))
    return "\n".join(lines)


def describe(c: dict) -> str:
    return f"“{c['question']}”: {c['rule']}"
