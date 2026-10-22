"""API endpoints for forecasts, actions, corrections and the claim suite (sign-in replaced by a test user)."""
import pytest
from fastapi.testclient import TestClient

from api.index import app, current_user


@pytest.fixture(scope="module")
def client():
    app.dependency_overrides[current_user] = lambda: {"email": "test@example.com", "iat": 0, "exp": 2**31}
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_forecast_endpoint(client):
    r = client.post("/api/forecast", json={"metric": "returned_units", "scope": "country", "key": "Germany", "horizon": 2})
    assert r.status_code == 200 and len(r.json()["forecast"]) == 2
    assert client.post("/api/forecast", json={"scope": "country", "key": "Narnia"}).status_code == 422
    assert "Germany" in client.get("/api/forecast/entities").json()["countries"]


def test_actions_endpoint(client):
    plan = client.get("/api/actions").json()
    assert plan["actions"] and plan["rules"]


def test_correct_then_ask_with_memory(client):
    opts = client.get("/api/corrections/options").json()
    assert any(c["key"] == "gross" for c in opts["choices"]["wrong_metric"])
    out = client.post("/api/correct", json={"question": "What were total sales in 2011?", "type": "wrong_metric",
                                            "choice": "gross", "rationale": "before returns", "mode": "offline"}).json()
    assert out["status"] == "success" and out["result"]["source"] == "learned"
    memory = [out["correction"]]
    r = client.post("/api/ask", json={"question": "What were total sales in 2010?", "mode": "offline", "corrections": memory}).json()
    assert "gross_revenue_gbp" in r["columns"] and r["applied_corrections"]
    r = client.post("/api/ask", json={"question": "What was net revenue in 2010?", "mode": "offline", "corrections": memory}).json()
    assert "net_revenue_gbp" in r["columns"] and not r["applied_corrections"]


def test_corrected_sql_from_the_browser_is_still_validated(client):
    evil = {"id": "x", "type": "other", "question": "What were total sales in 2011?", "rule": "r",
            "corrected_sql": "DELETE FROM transactions"}
    r = client.post("/api/ask", json={"question": "What were total sales in 2011?", "mode": "offline", "corrections": [evil]}).json()
    assert r["status"] == "blocked"


def test_claim_suite_endpoint(client):
    run = client.get("/api/evaluation/claims").json()
    assert run["caught"] == run["planted"]
