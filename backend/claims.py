"""Claim-to-evidence check: is every statement in an answer backed by the result it summarises?

The answer is split into atomic claims, and each one is checked against the executed result rows and the
facts of the SQL that produced them (backend/sql_facts.py):
  - numbers: a cell, or something derived from cells (a total, a share, a change, a ratio, a row count)
  - rankings ("X was the highest"): X must actually be first on the measure
  - trends ("rose", "fell"): the two periods must move that way
  - metric, period and exclusion wording: must match what the SQL computed
  - explanations ("because", "driven by", "likely"): an aggregate can't prove a cause, so these are hypotheses
Verdicts: supported, contradicted, unsupported, hypothesis, unchecked. Rule-based on purpose: the checker
must not be able to make the same fluent guess it is meant to catch.
"""
import re
from itertools import permutations

from .sql_facts import facts as sql_facts

MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]
MONTH_RE = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
NUMBER = re.compile(r"(?P<cur>£)?(?P<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(?P<scale>%|per ?cent|x\b|k\b|m\b|bn\b|million|billion|thousand))?",
                    re.IGNORECASE)
SCALES = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "bn": 1e9, "billion": 1e9}
APPROX = re.compile(r"\b(about|around|roughly|approximately|nearly|almost|some|close to|just under|just over|~)\s*$", re.I)
AT_LEAST = re.compile(r"\b(over|more than|above|at least|exceeding|upwards of)\s*$", re.I)
AT_MOST = re.compile(r"\b(under|less than|below|at most|up to)\s*$", re.I)
# Numbers that are not claims about the result: confidence levels, enumerations, dates, quarter names.
NOT_A_CLAIM = [
    re.compile(r"\b(?:80|95)\s?% (?:range|interval|prediction|of the time)", re.I),
    re.compile(r"\(\d{1,2}\)"),
    re.compile(r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:to\s+\d{1,2}\s+)?" + MONTH_RE + r"\b", re.I),
    re.compile(r"\b" + MONTH_RE + r"\s+\d{1,2}(?:st|nd|rd|th)?\b(?!,?\s*\d{3})", re.I),
    re.compile(r"\bq[1-4]\b", re.I),
    re.compile(r"\b20(?:0\d|1\d)(?:-\d{2})?\b"),
]
EXPLANATION = re.compile(r"\b(because|due to|driven by|thanks to|owing to|as a result|caused by|reflect(?:s|ing|ed)?|likely|probably|"
                         r"possibly|perhaps|suggest(?:s|ing)?|indicat(?:es|ing)|seasonal\w*|christmas|holiday\w*|promotion\w*|"
                         r"marketing|campaign|may (?:be|have)|might|could (?:be|have)|which means|this shows)\b", re.I)
RULE_STATEMENT = re.compile(r"\b(excluded|left out|not counted|are counted|is counted|means|ignored|only)\b", re.I)


def split_sentences(text: str) -> list[tuple[int, int]]:
    """(start, end) spans of sentences; decimals and "£1.2m" don't split."""
    spans, start = [], 0
    for m in re.finditer(r"[.!?](?=\s+[A-Z(£\d\"“])|[.!?]\s*$", text):
        spans.append((start, m.end()))
        start = m.end()
        while start < len(text) and text[start].isspace():
            start += 1
    if start < len(text) and text[start:].strip():
        spans.append((start, len(text)))
    return spans


def split_clauses(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Clauses inside a sentence, split on ';' and on ', ' before a new subject ("..., lowest was ...")."""
    out, s = [], start
    for m in re.finditer(r";\s+|,\s+(?=(?:and |while |but |whereas )?(?:the )?(?:highest|lowest|top|bottom|most|least|best|worst|followed|then)\b)",
                         text[start:end], re.I):
        out.append((s, start + m.start()))
        s = start + m.end()
    out.append((s, end))
    return out


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _label(col: str, row: int) -> str:
    return f"row {row + 1}, {col.replace('_', ' ')}"


class Evidence:
    """Every number the answer may legitimately quote, with where it comes from."""

    def __init__(self, columns: list[str], rows: list[list], extra: list[tuple[str, float]] | None = None):
        self.columns, self.rows = columns, rows[:50]
        self.cells: list[tuple[float, str]] = []
        self.derived: list[tuple[float, str]] = []
        self.percents: list[tuple[float, str]] = []
        self.ratios: list[tuple[float, str]] = []
        numeric = [i for i, _ in enumerate(columns) if self.rows and all(_is_num(r[i]) or r[i] is None for r in self.rows)]
        for ri, r in enumerate(self.rows):
            for ci in numeric:
                if r[ci] is not None:
                    self.cells.append((float(r[ci]), _label(columns[ci], ri)))
                    if -1.5 <= r[ci] <= 1.5 and re.search(r"rate|share|pct|percent|ratio|mape|error", columns[ci], re.I):
                        self.percents.append((float(r[ci]) * 100, _label(columns[ci], ri) + " as a percentage"))
        self.derived.append((float(len(rows)), "number of results"))
        for ci in numeric:
            vals = [(ri, float(r[ci])) for ri, r in enumerate(self.rows) if r[ci] is not None]
            col = columns[ci].replace("_", " ")
            total = sum(v for _, v in vals)
            if len(vals) > 1:
                self.derived.append((total, f"total of {col}"))
                self.derived.append((total / len(vals), f"average of {col}"))
            for ri, v in vals:
                if total and len(vals) > 1:
                    self.percents.append((v / total * 100, f"{_label(columns[ci], ri)} as a share of the total"))
            for (ra, a), (rb, b) in permutations(vals, 2):
                if b:
                    self.percents.append(((a - b) / abs(b) * 100, f"change from row {rb + 1} to row {ra + 1} in {col}"))
                    self.ratios.append((a / b, f"row {ra + 1} / row {rb + 1} in {col}"))
                self.derived.append((a - b, f"row {ra + 1} minus row {rb + 1} in {col}"))
        for label, v in extra or []:
            self.cells.append((float(v), label))
            if -1.5 <= v <= 1.5 and re.search(r"rate|share|error|%", label, re.I):
                self.percents.append((float(v) * 100, label + " as a percentage"))

    def find(self, value: float, tol: float, kind: str, qualifier: str | None) -> tuple[str, str] | None:
        """('direct' | 'derived', where) for the first source matching value within tol, honouring qualifiers."""
        pools = {"percent": [("direct", self.percents)], "ratio": [("derived", self.ratios)]}.get(
            kind, [("direct", self.cells), ("derived", self.derived)])

        def ok(c: float) -> bool:
            c = abs(c) if kind == "percent" else c
            if qualifier == "at_least":
                return value - tol <= c <= value * 1.25 + tol
            if qualifier == "at_most":
                return value * 0.75 - tol <= c <= value + tol
            if qualifier == "approx":
                return abs(c - value) <= max(tol, abs(value) * 0.1)
            return abs(c - value) <= max(tol, abs(value) * 1e-6)

        for how, pool in pools:
            for c, where in pool:
                if ok(c):
                    return how, where
        return None

    def nearest(self, value: float) -> float | None:
        cands = [c for c, _ in self.cells + self.derived]
        return min(cands, key=lambda c: abs(c - value)) if cands else None


def parse_number(m: re.Match) -> tuple[float, float, str]:
    """(value, tolerance from the written precision, kind: number | percent | ratio)."""
    raw = m.group("num").replace(",", "")
    decimals = len(raw.split(".")[1]) if "." in raw else 0
    scale_word = (m.group("scale") or "").lower().replace(" ", "")
    kind = "percent" if scale_word in ("%", "percent") else "ratio" if scale_word == "x" else "number"
    scale = SCALES.get(scale_word, 1.0)
    return float(raw) * scale, 0.5 * 10 ** -decimals * scale + (0.01 if kind == "number" else 0), kind
