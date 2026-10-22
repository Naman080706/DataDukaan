"""Claim-to-evidence checker and the evaluation failure taxonomy. Run: python -m pytest tests"""
from unittest import mock

from backend import agent, evaluation, sql_facts
from backend.claims import check_answer

MONTHLY = [["2011-09", 1019687.62], ["2011-10", 1070704.67], ["2011-11", 1461756.25]]
MONTHLY_SQL = ("SELECT strftime(invoice_date, '%Y-%m') AS month, ROUND(SUM(line_value), 2) AS net_revenue_gbp FROM transactions "
               "WHERE line_type IN ('sale', 'cancellation') AND invoice_date >= '2011-09-01' AND invoice_date < '2011-12-01' GROUP BY 1 ORDER BY 1")
COLS = ["month", "net_revenue_gbp"]


def verdicts(answer):
    return [(c["type"], c["verdict"]) for c in check_answer(answer, COLS, MONTHLY, MONTHLY_SQL)["claims"]]


def test_numbers_must_come_from_the_result_or_be_derived_from_it():
    assert ("number", "supported") in verdicts("November 2011 brought in £1,461,756.25.")
    assert ("number", "supported") in verdicts("November was up 36.5% on October.")       # derived: change between rows
    assert ("number", "supported") in verdicts("Together the three months made £3.55 million.")  # derived: total
    assert ("number", "unsupported") in verdicts("November 2011 brought in £1,900,000.")


def test_written_precision_sets_the_tolerance():
    assert ("number", "supported") in verdicts("November made £1.46 million.")
    assert ("number", "unsupported") in verdicts("November made £1.50 million.")
    assert ("number", "supported") in verdicts("November made about £1.5 million.")


def test_rankings_and_trends_are_checked_against_the_rows():
    assert ("ranking", "supported") in verdicts("The best month was November 2011.")
    assert ("ranking", "contradicted") in verdicts("The best month was September 2011.")
    assert ("trend", "supported") in verdicts("Revenue rose from October 2011 to November 2011.")
    assert ("trend", "contradicted") in verdicts("Revenue fell from October 2011 to November 2011.")


def test_explanations_are_hypotheses():
    out = check_answer("November 2011 was highest, probably because of Christmas shopping.", COLS, MONTHLY, MONTHLY_SQL)
    assert out["status"] == "hypotheses" and "unsupported_causal" in out["categories"]


def test_metric_and_period_wording_must_match_the_sql():
    assert check_answer("Gross revenue was £1,461,756.25.", COLS, MONTHLY, MONTHLY_SQL)["categories"] == ["wrong_metric"]
    assert "wrong_period" in check_answer("In 2010 the best month made £1,461,756.25.", COLS, MONTHLY, MONTHLY_SQL)["categories"]


def test_result_names_are_not_read_as_claims():
    rows = [["22086", "PAPER CHAIN KIT 50'S CHRISTMAS", 28883.04], ["23084", "MEDIUM CERAMIC TOP STORAGE JAR", 1000.0]]
    out = check_answer("Top of the list: PAPER CHAIN KIT 50'S CHRISTMAS (£28,883.04); MEDIUM CERAMIC TOP STORAGE JAR (£1,000.00).",
                       ["stock_code", "description", "net_revenue_gbp"], rows)
    assert out["status"] == "grounded", out["claims"]


def test_planted_error_suite_catches_everything_without_false_alarms():
    run = evaluation.run_claim_suite()
    assert run["caught"] == run["planted"] and run["false_alarms"] == 0, [r for r in run["results"] if not r["passed"]]


def test_offline_answers_are_all_grounded():
    for t in evaluation.load_suite():
        r = agent.ask(t["question"], mode="offline", use_cache=False)
        if r["status"] == "success":
            assert r["claims"]["status"] == "grounded", (t["id"], r["answer"], r["claims"]["claims"])


def test_unsupported_ai_draft_is_rewritten_from_the_rows():
    plan = {"action": "sql", "sql": MONTHLY_SQL, "assumptions": [], "title": "Net revenue by month", "_model": "fake"}

    def fake(system, user, temperature=0.0, fast=False):
        if "store manager" in system:
            return {"answer": "Revenue peaked in November 2011 at £1.9 million, likely thanks to a promotion."}
        return dict(plan)

    with mock.patch.object(agent, "generate_json", fake), mock.patch.dict("os.environ", {"GEMINI_API_KEY": "x"}):
        r = agent.ask("Show net revenue by month for autumn 2011", use_cache=False)
    assert r["draft_answer"].startswith("Revenue peaked") and "£1.9 million" not in r["answer"]
    assert r["claims"]["status"] == "grounded"
    assert {"unsupported_number", "unsupported_causal"} <= set(r["draft_claims"]["categories"])


def test_failure_taxonomy_from_sql_differences():
    ref = ("SELECT stock_code, SUM(quantity) AS units FROM transactions WHERE line_type = 'sale' AND is_product "
           "GROUP BY stock_code ORDER BY units DESC LIMIT 5")
    assert sql_facts.diff(ref, ref.replace(" AND is_product", "")) == ["missing_exclusion"]
    assert sql_facts.diff(ref, ref.replace("GROUP BY stock_code", "GROUP BY country").replace("SELECT stock_code", "SELECT country")) == ["wrong_grouping"]
    assert sql_facts.diff(ref, ref.replace("line_type = 'sale'", "line_type IN ('sale', 'cancellation')")) == ["wrong_metric"]
