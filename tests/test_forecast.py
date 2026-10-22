"""Forecasting tool and prescriptive layer. Run: python -m pytest tests"""
import math

import pytest

from backend import actions, ahead
from backend.forecast import ForecastError, cap_spikes, forecast, forecast_series, month_range, parse_question


def seasonal_history(years=2, base=100.0, growth=1.1):
    shape = [1.0, 0.7, 0.6, 0.8, 0.8, 0.9, 0.9, 0.9, 1.0, 1.3, 1.6, 2.0]  # Dec..Nov, peak in Nov
    months = month_range("2009-12", "2011-11")[: 12 * years]
    return [(m, base * shape[i % 12] * growth ** (i // 12)) for i, m in enumerate(months)]


def test_seasonal_series_picks_seasonal_model_and_follows_the_pattern():
    f = forecast_series(seasonal_history(), horizon=3)
    assert f["model"]["name"] == "seasonal"
    dec, jan, feb = (p["value"] for p in f["forecast"])
    assert dec > jan > feb  # the drop after the November peak is kept
    assert [p["period"] for p in f["forecast"]] == ["2011-12", "2012-01", "2012-02"]


def test_intervals_are_ordered_and_non_negative():
    f = forecast_series(seasonal_history(), horizon=3)
    for p in f["forecast"]:
        assert 0 <= p["lo95"] <= p["lo80"] <= p["value"] <= p["hi80"] <= p["hi95"]
    assert f["total"]["lo80"] <= f["total"]["value"] <= f["total"]["hi80"]


def test_thin_history_never_gives_a_zero_width_range():
    f = forecast_series([("2011-07", 1), ("2011-08", 0), ("2011-09", 6), ("2011-10", 210), ("2011-11", 6)], horizon=3)
    assert all(p["hi80"] > p["lo80"] for p in f["forecast"])


def test_too_little_history_is_refused():
    with pytest.raises(ForecastError):
        forecast_series([("2011-10", 5), ("2011-11", 6)], horizon=1)


def test_spikes_are_capped_only_when_robust():
    y = [10, 12, 9, 11, 10, 500, 12, 11]
    capped, cap = cap_spikes(y)
    assert cap is not None and max(capped) < 500
    f = forecast_series([(m, v) for m, v in zip(month_range("2011-04", "2011-11"), y)], 1, robust=True)
    assert f["capped"] == [{"period": "2011-09", "value": 500.0}]


def test_parse_question():
    assert parse_question("What should I expect next month?", []) == {"metric": "net_revenue", "scope": "total", "key": None, "horizon": 1}
    assert parse_question("Forecast returns for Germany next quarter", ["Germany"])["scope"] == "country"
    assert parse_question("predict units of 85123A over the next 2 months", [])["key"] == "85123A"
    assert parse_question("What was net revenue in 2011?", []) is None


def test_forecast_from_the_database():
    f = forecast("net_revenue", "total", None, 3)
    assert f["history"][-1]["period"] == "2011-11"
    assert f["backtest"]["mape"] < 0.25  # the shop total is strongly seasonal and forecastable
    assert "invoice_date < '2011-12-01'" in f["sql"]


def test_unknown_entities_are_refused():
    with pytest.raises(ForecastError):
        forecast("net_revenue", "country", "Narnia")
    with pytest.raises(ForecastError):
        forecast("net_revenue", "country", "x' OR 1=1 --")


def test_action_plan_is_ranked_and_backed_by_rules():
    plan = actions.action_plan(limit=50)
    rule_ids = {r["id"] for r in actions.BUSINESS_RULES}
    assert plan["actions"], "expected at least one action"
    assert [a["rank"] for a in plan["actions"]] == list(range(1, len(plan["actions"]) + 1))
    assert all(a["priority"] >= b["priority"] for a, b in zip(plan["actions"], plan["actions"][1:]))
    for a in plan["actions"]:
        assert a["rule"] in rule_ids and a["evidence"] and a["at_stake_gbp"] >= 0
    assert sum(plan["counts"].values()) == len(plan["diagnoses"])


def test_bulk_cancellation_product_is_critical_and_its_customers_are_flagged():
    plan = actions.action_plan(limit=50)
    jar = next(d for d in plan["diagnoses"] if d["key"] == "23166")  # 74,215 units ordered and cancelled in Jan 2011
    assert jar["status"] == "Critical" and "R1" in jar["rules"]
    assert any(a["rule"] == "R3" and a["entity"]["key"] == "23166" for a in plan["actions"])


def test_ask_box_routes_future_questions():
    r = ahead.forecast_answer("What should I expect next month?", [])
    assert r["kind"] == "forecast" and len(r["rows"]) == 1 and r["chart_type"] == "forecast"
    assert ahead.forecast_answer("forecast revenue for Narnia", ["Germany"])["status"] == "clarification"
    assert ahead.is_actions_question("What should we do about returns?")
    assert not ahead.is_actions_question("Which products were returned most frequently?")
    assert math.isclose(r["rows"][0][1], r["forecast"]["forecast"][0]["value"])
