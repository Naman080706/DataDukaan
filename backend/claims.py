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


def col_words(col: str) -> str:
    """'forecast_net_revenue_gbp' -> 'forecast net revenue (£)', as the answer page shows columns."""
    return col.removesuffix("_gbp").replace("_", " ") + (" (£)" if col.endswith("_gbp") else "")


def _label(col: str, row: int) -> str:
    return f"row {row + 1}, {col_words(col)}"


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
            col = col_words(columns[ci])
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


HIGH = re.compile(r"\b(highest|most|top|biggest|largest|best|strongest|leading|led|topped|peak(?:ed)?|record|greatest)\b", re.I)
LOW = re.compile(r"\b(lowest|least|fewest|smallest|worst|weakest|bottom)\b", re.I)
UP = re.compile(r"\b(rose|risen|increased?|grew|grown|up|higher|climbed|jumped|more than)\b", re.I)
DOWN = re.compile(r"\b(fell|fallen|decreased?|declined?|dropped|down|lower|shrank|less than)\b", re.I)
LIST_SIZE = re.compile(r"\b(?:top|first|bottom|best|worst)\s+(\d{1,3})\b", re.I)
SAYS = {
    "net": re.compile(r"\bnet (?:revenue|sales)\b|sales minus returns|after returns", re.I),
    "gross": re.compile(r"\bgross\b|excluding cancel\w*|before returns|excluding returns|without (?:cancel\w*|returns)", re.I),
    "units": re.compile(r"\bunits sold\b", re.I),
    "returned_units": re.compile(r"\b(?:units returned|returned units)\b", re.I),
}
CONFLICTS = {"net": {"gross"}, "gross": {"net", "total_value"}, "units": {"returned_units"}, "returned_units": {"units"}}
MEASURE_WORDS = {"net": "net revenue (sales minus returns)", "gross": "sales only, before returns", "units": "units sold",
                 "returned_units": "units returned", "orders": "orders", "return_invoices": "return invoices",
                 "customers": "customers", "total_value": "every line, including write-offs", "return_value": "value of returns"}
EXCLUDE_VERB = re.compile(r"\b(excluded|excluding|left out|leaving out|not counted|removed|without|except|outside|other than|apart from|only)\b", re.I)
CLAIM_CATEGORIES = {
    "wrong_metric": "Wrong metric definition", "wrong_period": "Wrong filter or period",
    "missing_exclusion": "Missing exclusion rule", "misread_result": "Correct SQL, misread result",
    "unsupported_number": "Number not in the result", "unsupported_causal": "Unsupported explanation",
}


def _period_aliases(v: str) -> list[str]:
    m = re.fullmatch(r"(\d{4})-(\d{2})(?:-\d{2})?", v)
    if m:
        name = MONTHS[int(m.group(2)) - 1]
        return [v, f"{name} {m.group(1)}", f"{name[:3]} {m.group(1)}"]
    m = re.fullmatch(r"(\d{4})-Q([1-4])", v)
    return [v, f"q{m.group(2)} {m.group(1)}"] if m else [v]


def row_labels(columns: list[str], rows: list[list]) -> list[tuple[int, list[str], bool]]:
    """(row index, lower-case names the answer may use for that row, is a time period)."""
    text_cols = [i for i, _ in enumerate(columns) if rows and any(isinstance(r[i], str) for r in rows)]
    # Only columns that tell rows apart name them; repeated values ("Critical", a constant best_month) are categories.
    varying = [i for i in text_cols if len({r[i] for r in rows}) == len(rows)]
    out = []
    for ri, r in enumerate(rows[:50]):
        names = [a.lower() for i in varying if isinstance(r[i], str) and len(r[i]) >= 2 for a in _period_aliases(r[i].strip())]
        is_time = any(re.fullmatch(r"\d{4}-(?:\d{2}|Q[1-4])", str(r[i])) for i in varying)
        if names:
            out.append((ri, names, is_time))
    return out


def _mentions(text: str, labels) -> list[tuple[int, int, bool]]:
    """(position, row index, is_time) of each row label mentioned in text, in order of appearance."""
    low, found = text.lower(), []
    for ri, names, is_time in labels:
        hits = [m.start() for n in names for m in re.finditer(r"(?<![\w])" + re.escape(n) + r"(?![\w])", low)]
        if hits:
            found.append((min(hits), ri, is_time))
    return sorted(found)


def _value_col(columns: list[str], rows: list[list]) -> int | None:
    numeric = [i for i in range(len(columns)) if rows and all(_is_num(r[i]) or r[i] is None for r in rows)]
    return numeric[-1] if numeric else None


def check_answer(answer: str, columns: list[str], rows: list[list], sql: str | None = None, question: str = "",
                 assumptions: list[str] | None = None, extra: list[tuple[str, float]] | None = None,
                 countries: list[str] | None = None) -> dict:
    claims: list[dict] = []
    f = sql_facts(sql) if sql else None
    ev = Evidence(columns, rows, extra)
    labels = row_labels(columns, rows)
    vcol = _value_col(columns, rows)
    context = " ".join([question] + list(assumptions or [])).lower()
    cells_text = " ".join(str(v) for r in rows for v in r).lower()

    def add(kind, start, end, verdict, evidence, category=None):
        claims.append({"id": len(claims) + 1, "type": kind, "text": answer[start:end].strip(), "start": start, "end": end,
                       "verdict": verdict, "evidence": evidence, "category": category if verdict != "supported" else None})

    for s, e in split_sentences(answer):
        sent = answer[s:e]
        if f:
            _check_semantics(sent, s, f, add, context, cells_text)
        for c in countries or []:
            for m in re.finditer(r"\b" + re.escape(c) + r"\b", sent):
                if c.lower() not in cells_text and c.lower() not in context and not (f and c in f["countries"] + f["excluded_countries"]):
                    add("entity", s + m.start(), s + m.end(), "unsupported", f"{c} does not appear in the result", "misread_result")
        for cs, ce in split_clauses(answer, s, e):
            _check_clause(answer, cs, ce, ev, labels, rows, columns, vcol, add)

    claims.sort(key=lambda c: (c["start"], c["id"]))
    counts = {v: sum(c["verdict"] == v for c in claims) for v in ("supported", "contradicted", "unsupported", "hypothesis")}
    checkable = counts["supported"] + counts["contradicted"] + counts["unsupported"]
    status = ("contradicted" if counts["contradicted"] else "unsupported" if counts["unsupported"]
              else "hypotheses" if counts["hypothesis"] else "grounded")
    return {"status": status, "claims": claims, "counts": counts,
            "grounded_share": round(counts["supported"] / checkable, 3) if checkable else None,
            "categories": sorted({c["category"] for c in claims if c["category"]})}


def _check_clause(answer: str, cs: int, ce: int, ev: Evidence, labels, rows, columns, vcol, add) -> None:
    clause = answer[cs:ce]
    low = clause.lower()
    label_spans = [(p, p + len(n)) for _, names, _ in labels for n in names for p in [low.find(n)] if p >= 0]
    # Names from the result ("PAPER CHAIN KIT 50'S CHRISTMAS") are neither numbers nor explanations.
    bare = "".join(" " if any(a <= i < b for a, b in label_spans) else ch for i, ch in enumerate(clause))
    if EXPLANATION.search(bare) and not (RULE_STATEMENT.search(bare) and EXCLUDE_VERB.search(bare)):
        add("explanation", cs, ce, "hypothesis", "An explanation of why: the figures show what happened, not the cause.",
            "unsupported_causal")
    masked = [(m.start(), m.end()) for p in NOT_A_CLAIM for m in p.finditer(clause)] + label_spans
    for m in LIST_SIZE.finditer(clause):
        n = int(m.group(1))
        masked.append((m.start(1), m.end(1)))
        ok = len(rows) >= n
        add("list_size", cs + m.start(), cs + m.end(), "supported" if ok else "contradicted",
            f"the result has {len(rows)} rows", None if ok else "misread_result")
    matched_cols = []
    for m in NUMBER.finditer(clause):
        if any(a <= m.start() < b or a < m.end() <= b for a, b in masked):
            continue
        value, tol, kind = parse_number(m)
        before = clause[:m.start()]
        qual = "approx" if APPROX.search(before) else "at_least" if AT_LEAST.search(before) else "at_most" if AT_MOST.search(before) else None
        hit = ev.find(value, tol, kind, qual)
        if hit:
            add("number", cs + m.start(), cs + m.end(), "supported", f"{'matches' if hit[0] == 'direct' else 'derived from'} {hit[1]}")
            col = next((ci for ci, c in enumerate(columns) if hit[1].endswith(", " + col_words(c))), None)
            if col is not None:
                matched_cols.append(col)
        else:
            near = ev.nearest(value) if kind == "number" else None
            close = bool(near) and abs(near - value) / abs(near) <= 0.2
            add("number", cs + m.start(), cs + m.end(), "unsupported",
                f"not in the result{f' (closest value is {near:,.2f})' if close else ''}", "misread_result" if close else "unsupported_number")
    _check_order(clause, bare, cs, labels, rows, matched_cols[0] if matched_cols else vcol, add)


def _check_order(clause: str, bare: str, cs: int, labels, rows, col: int | None, add) -> None:
    """Rankings ("X was the highest") and comparisons/trends ("rose from A to B") against the value column.
    Superlatives are looked for in `bare` (the clause with result names blanked out: "CERAMIC TOP STORAGE JAR")."""
    if col is None or len(rows) < 2:
        return
    found = _mentions(clause, labels)
    if not found:
        return
    val = lambda ri: rows[ri][col] if rows[ri][col] is not None else 0  # noqa: E731
    span = (cs + found[0][0], cs + len(clause))
    hi, lo = HIGH.search(bare), LOW.search(bare)
    if (hi or lo) and not (hi and lo):
        target = (max if hi else min)(range(len(rows)), key=val)
        order = [ri for _, ri, _ in found]
        ok = val(order[0]) == val(target)
        ok = ok and all((val(a) >= val(b)) if hi else (val(a) <= val(b)) for a, b in zip(order, order[1:]))
        add("ranking", *span, "supported" if ok else "contradicted",
            f"the {'highest' if hi else 'lowest'} in the result is row {target + 1}" + ("" if ok else f", not row {order[0] + 1}"),
            None if ok else "misread_result")
        return
    up, down = UP.search(bare), DOWN.search(bare)
    if len(found) >= 2 and (up or down) and not (up and down):
        (_, a, ta), (_, b, tb) = found[0], found[1]
        if ta and tb:  # time periods: compare in calendar order
            a, b = sorted((a, b), key=lambda ri: str(rows[ri]))
            ok = val(b) > val(a) if up else val(b) < val(a)
        else:  # "A was higher than B"
            ok = val(a) > val(b) if up else val(a) < val(b)
        add("trend", *span, "supported" if ok else "contradicted",
            f"row {a + 1} is {val(a):,.2f} and row {b + 1} is {val(b):,.2f}", None if ok else "misread_result")


def _month_key(mon: str, year: int) -> str:
    return f"{year}-{next(i for i, x in enumerate(MONTHS, 1) if x.startswith(mon.lower()[:3])):02d}"


def _check_semantics(sent: str, s: int, f: dict, add, context: str, cells_text: str) -> None:
    """Metric, period and exclusion wording against what the SQL actually computed."""
    for says, rx in SAYS.items():
        m = rx.search(sent)
        if m and f["measure"]:
            bad = f["measure"] in CONFLICTS.get(says, set())
            add("metric", s + m.start(), s + m.end(), "contradicted" if bad else "supported",
                f"the calculation counted {MEASURE_WORDS.get(f['measure'], f['measure'])}", "wrong_metric" if bad else None)
    for m in re.finditer(r"\b(?:in|during|for|of|throughout)\s+(?:(" + MONTH_RE + r")\s+)?(20(?:09|1[0-2]))\b", sent, re.I):
        year, mon = int(m.group(2)), m.group(1)
        key = _month_key(mon, year) if mon else str(year)
        named = f"{mon} {year}".lower() if mon else str(year)
        if key in cells_text or named in context:
            add("period", s + m.start(), s + m.end(), "supported", "appears in the result or the question")
        elif f["period"]:
            inside = (f["period"][0][:len(key)] <= key < f["period"][1][:len(key)]) if mon else year in f["years"]
            add("period", s + m.start(), s + m.end(), "supported" if inside else "contradicted",
                f"the calculation covered {f['period'][0]} up to {f['period'][1]}", None if inside else "wrong_period")
        else:
            add("period", s + m.start(), s + m.end(), "contradicted", "the calculation was not limited to any period", "wrong_period")
    checks = [
        (r"\b(?:postage|fees|non-product\w*|carriage)\b|\bproducts only\b", "products_only", "postage and fees left out"),
        (r"\b(?:unknown|missing|anonymous|unidentified)\s+customers?\b|\bwithout (?:an? )?(?:customer )?id\b", "known_customers_only",
         "customers without an ID left out"),
        (r"\b(?:outside|excluding|other than|apart from|except)\s+(?:the\s+)?(?:uk|united kingdom)\b", "excludes_uk", "the UK left out"),
    ]
    for rx, fact, words in checks:
        m = re.search(rx, sent, re.I)
        if not m or not EXCLUDE_VERB.search(sent):
            continue
        has = "United Kingdom" in f["excluded_countries"] if fact == "excludes_uk" else f[fact]
        add("exclusion", s + m.start(), s + m.end(), "supported" if has else "contradicted",
            f"the calculation {'has' if has else 'does not have'} {words}", None if has else "missing_exclusion")
