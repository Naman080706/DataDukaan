"""FastAPI app. Served by Vercel as a Python function and locally with uvicorn."""
import os
import sys
import uuid
from collections import OrderedDict
from typing import Literal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(ROOT, ".env"))
except ImportError:  # not installed on Vercel; env vars come from the project settings
    pass

from fastapi import Depends, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from backend import actions, auth, client_agent, db, evaluation, forecast, memory  # noqa: E402
from backend.agent import ask, correct  # noqa: E402
from backend.rules import AMBIGUITY_RULES, DATA_RULES, DATASET_END, DATASET_START, NON_PRODUCT_CODES  # noqa: E402

app = FastAPI(title="DataDukaan API", version="1.0")


@app.exception_handler(auth.AuthError)
def auth_error(_: Request, e: auth.AuthError):
    return JSONResponse(status_code=e.status, content={"detail": str(e)})


def current_user(authorization: str | None = Header(default=None)) -> dict:
    """Every data endpoint needs a signed-in user (Authorization: Bearer <session token>)."""
    token = authorization.removeprefix("Bearer ").strip() if authorization else None
    return auth.read_token(token)


Signed = Depends(current_user)

# Best-effort query history (per server instance; serverless instances do not share it).
HISTORY: "OrderedDict[str, dict]" = OrderedDict()
HISTORY_MAX = 200


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)
    sql: str | None = Field(default=None, max_length=4000)


class Correction(BaseModel):
    """One remembered correction. Kept in the user's browser and sent with each question (the server stores none)."""
    id: str = Field(max_length=40)
    type: Literal["wrong_metric", "wrong_period", "wrong_grouping", "missing_exclusion", "other"]
    question: str = Field(max_length=1000)
    rule: str = Field(max_length=500)
    rationale: str = Field(default="", max_length=1000)
    original_sql: str | None = Field(default=None, max_length=6000)
    corrected_sql: str | None = Field(default=None, max_length=6000)  # re-validated before it is ever run
    override: dict = {}
    term: str | None = Field(default=None, max_length=60)
    title: str = Field(default="", max_length=300)
    assumptions: list[str] = []
    enabled: bool = True


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    conversation_id: str | None = Field(default=None, max_length=100)
    # Only the last few turns reach the prompt; the cap stops oversized (costly) requests.
    history: list[Turn] = Field(default=[], max_length=12)
    inject_fault: bool = False
    # "auto": saved answers, then AI, then offline engine. "offline": rule engine only (outage demo).
    mode: Literal["auto", "offline"] = "auto"
    corrections: list[Correction] = Field(default=[], max_length=100)


class CorrectRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    original_sql: str | None = Field(default=None, max_length=6000)
    type: Literal["wrong_metric", "wrong_period", "wrong_grouping", "missing_exclusion", "other"]
    choice: str | None = Field(default=None, max_length=40)
    rationale: str = Field(default="", max_length=1000)
    history: list[Turn] = []
    mode: Literal["auto", "offline"] = "auto"


class ForecastRequest(BaseModel):
    metric: Literal["net_revenue", "units_sold", "orders", "returned_units", "return_value"] = "net_revenue"
    scope: Literal["total", "country", "product"] = "total"
    key: str | None = Field(default=None, max_length=100)
    horizon: int = Field(default=3, ge=1, le=6)


class CodeRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class VerifyRequest(BaseModel):
    challenge: str = Field(min_length=10, max_length=2000)
    code: str = Field(min_length=1, max_length=20)


class Column(BaseModel):
    name: str = Field(max_length=200)
    type: str = Field(max_length=60)


class DatasetInfo(BaseModel):
    """What the browser tells us about a user's own dataset. The data itself stays in the browser."""
    kind: Literal["retail", "generic"]
    source: str = Field(default="uploaded file", max_length=200)
    columns: list[Column] = Field(max_length=200)
    sample_rows: list[list] = Field(default=[], max_length=5)
    row_count: int = 0
    date_range: list[str | None] = [None, None]
    countries: list[str] = Field(default=[], max_length=400)
    # Per-column profile measured in the browser: blanks, distinct count, range, average, common values.
    column_stats: list[dict] = Field(default=[], max_length=120)


class Observation(BaseModel):
    """A look-up the AI asked for and the browser ran on the user's data."""
    sql: str = Field(max_length=4000)
    why: str = Field(default="", max_length=400)
    columns: list[str] = Field(default=[], max_length=60)
    rows: list[list] = Field(default=[], max_length=50)
    error: str | None = Field(default=None, max_length=600)


class DatasetPlanRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    history: list[Turn] = []
    dataset: DatasetInfo
    mode: Literal["auto", "offline"] = "auto"
    observations: list[Observation] = Field(default=[], max_length=2)


class DatasetFixRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    sql: str = Field(max_length=8000)
    error: str = Field(max_length=2000)
    dataset: DatasetInfo


class DatasetSummaryRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    title: str = Field(default="", max_length=300)
    assumptions: list[str] = Field(default=[], max_length=12)
    columns: list[str] = Field(max_length=60)
    rows: list[list] = Field(max_length=50)
    source: Literal["ai", "offline"] = "ai"
    total_rows: int | None = None


class EvalRequest(BaseModel):
    # One test per request from the UI; the cap stops one call from running the whole paid suite.
    ids: list[str] = Field(min_length=1, max_length=5)
    mode: Literal["llm", "offline"] = "llm"
    check_answers: bool = False  # also write and claim-check the answer (one more AI call per test)


@app.get("/api/health")
def health():
    try:
        schema = db.get_schema()
        return {"status": "ok", "database": "ready", "rows": schema["row_count"],
                "llm_configured": bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GROQ_API_KEY")),
                "providers": [p for p, k in (("gemini", "GEMINI_API_KEY"), ("groq", "GROQ_API_KEY")) if os.environ.get(k)],
                "email_sign_in": auth.emailjs_configured() and len(os.environ.get("AUTH_SECRET", "")) >= 32}
    except Exception as e:
        print(f"health check failed: {e!r}")
        return {"status": "degraded", "database": "error"}


@app.post("/api/auth/request-code")
def auth_request_code(req: CodeRequest):
    return auth.request_code(req.email)


@app.post("/api/auth/verify")
def auth_verify(req: VerifyRequest):
    return auth.verify_code(req.challenge, req.code)


@app.get("/api/auth/me")
def auth_me(user: dict = Signed):
    return {"email": user["email"], "signed_in_at": user["iat"], "expires_at": user["exp"]}


@app.get("/api/schema")
def schema(user: dict = Signed):
    return db.get_schema()


@app.get("/api/rules")
def rules(user: dict = Signed):
    return {"data_rules": DATA_RULES, "ambiguity_rules": AMBIGUITY_RULES, "non_product_codes": NON_PRODUCT_CODES,
            "dataset_range": [DATASET_START, DATASET_END]}


@app.post("/api/ask")
def ask_endpoint(req: AskRequest, user: dict = Signed):
    result = ask(req.question.strip(), [t.model_dump() for t in req.history], inject_fault=req.inject_fault, mode=req.mode,
                 corrections=[c.model_dump() for c in req.corrections])
    qid = uuid.uuid4().hex[:12]
    result["id"] = qid
    result["conversation_id"] = req.conversation_id
    HISTORY[qid] = {**result, "_owner": user["email"]}
    while len(HISTORY) > HISTORY_MAX:
        HISTORY.popitem(last=False)
    return result


@app.post("/api/dataset/plan")
def dataset_plan(req: DatasetPlanRequest, user: dict = Signed):
    return client_agent.plan(req.question.strip(), [t.model_dump() for t in req.history], req.dataset.model_dump(), req.mode,
                             [o.model_dump() for o in req.observations])


@app.post("/api/dataset/fix")
def dataset_fix(req: DatasetFixRequest, user: dict = Signed):
    return client_agent.fix(req.question, req.sql, req.error, req.dataset.model_dump())


@app.post("/api/dataset/summarise")
def dataset_summarise(req: DatasetSummaryRequest, user: dict = Signed):
    return client_agent.summarise(req.question, req.title, req.assumptions, req.columns, req.rows, req.source, req.total_rows)


@app.get("/api/corrections/options")
def correction_options(user: dict = Signed):
    """The structured choices offered under each kind of correction."""
    return {"types": memory.TYPES,
            "choices": {kind: [{"key": k, "label": v[0]} for k, v in opts.items()] for kind, opts in memory.CHOICES.items()}}


@app.post("/api/correct")
def correct_endpoint(req: CorrectRequest, user: dict = Signed):
    """Work out the corrected answer and the correction to remember. Nothing is stored until the browser keeps it."""
    out = correct(req.question.strip(), req.original_sql, req.type, req.choice, req.rationale,
                  [t.model_dump() for t in req.history], req.mode)
    if out.get("result"):
        out["result"]["id"] = uuid.uuid4().hex[:12]
        HISTORY[out["result"]["id"]] = out["result"]
    return out


@app.post("/api/forecast")
def forecast_endpoint(req: ForecastRequest, user: dict = Signed):
    try:
        return forecast.forecast(req.metric, req.scope, req.key, req.horizon)
    except forecast.ForecastError as e:
        raise HTTPException(422, str(e))


@app.get("/api/forecast/entities")
def forecast_entities(user: dict = Signed):
    """Countries and the top products, for the forecast pickers."""
    countries = db.execute_readonly_sql("SELECT country FROM transactions GROUP BY country ORDER BY SUM(line_value) DESC")["rows"]
    products = db.execute_readonly_sql(
        "SELECT stock_code, mode(description) FILTER (WHERE line_type = 'sale') FROM transactions WHERE line_type = 'sale' AND is_product "
        "AND invoice_date >= '2010-12-01' GROUP BY stock_code ORDER BY SUM(line_value) DESC LIMIT 100")["rows"]
    return {"countries": [r[0] for r in countries], "products": [{"code": r[0], "description": r[1]} for r in products],
            "metrics": {k: {"label": v[2], "unit": v[3]} for k, v in forecast.METRICS.items()}}


@app.get("/api/actions")
def actions_endpoint(user: dict = Signed):
    return actions.action_plan(limit=25)


@app.get("/api/query/{qid}")
def get_query(qid: str, user: dict = Signed):
    entry = HISTORY.get(qid)
    if entry is None or entry["_owner"] != user["email"]:
        raise HTTPException(404, "Query not found (history is kept in memory per server instance).")
    return {k: v for k, v in entry.items() if k != "_owner"}


@app.get("/api/evaluation/suite")
def suite(user: dict = Signed):
    return evaluation.load_suite()


@app.post("/api/evaluation/run")
def run_eval(req: EvalRequest, user: dict = Signed):
    # The UI runs one test per request so long suites never hit serverless time limits.
    return evaluation.run_suite(req.ids, req.mode, req.check_answers)


class LearningRequest(BaseModel):
    ids: list[str] | None = None
    mode: Literal["llm", "offline"] = "offline"


@app.get("/api/evaluation/learning/suite")
def learning_suite(user: dict = Signed):
    return evaluation.load_learning_suite()


@app.post("/api/evaluation/learning")
def run_learning(req: LearningRequest, user: dict = Signed):
    """Teach each scenario's correction and compare its probes before and after (the UI sends one scenario per request)."""
    return evaluation.run_learning_suite(req.ids, req.mode)


@app.get("/api/evaluation/learning/results")
def learning_results(mode: Literal["llm", "offline"] = "offline", user: dict = Signed):
    res = evaluation.load_learning_results(mode)
    if res is None:
        raise HTTPException(404, "No saved learning run yet.")
    return res


@app.get("/api/evaluation/claims")
def eval_claims(user: dict = Signed):
    """Runs the planted-error claim suite live (no AI calls, so it is fast)."""
    return evaluation.run_claim_suite()


@app.get("/api/evaluation/results")
def eval_results(mode: Literal["llm", "offline"] = "llm", user: dict = Signed):
    res = evaluation.load_results(mode)
    if res is None:
        raise HTTPException(404, "No saved evaluation run yet.")
    return res
