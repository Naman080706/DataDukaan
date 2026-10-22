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

from backend import auth, client_agent, db, evaluation  # noqa: E402
from backend.agent import ask  # noqa: E402
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
    role: str
    content: str
    sql: str | None = None


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    conversation_id: str | None = None
    history: list[Turn] = []
    inject_fault: bool = False
    # "auto": saved answers, then AI, then offline engine. "offline": rule engine only (outage demo).
    mode: Literal["auto", "offline"] = "auto"


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
    ids: list[str] | None = None
    mode: Literal["llm", "offline"] = "llm"


@app.get("/api/health")
def health():
    try:
        schema = db.get_schema()
        return {"status": "ok", "database": "ready", "rows": schema["row_count"],
                "llm_configured": bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GROQ_API_KEY")),
                "providers": [p for p, k in (("gemini", "GEMINI_API_KEY"), ("groq", "GROQ_API_KEY")) if os.environ.get(k)],
                "email_sign_in": auth.emailjs_configured() and len(os.environ.get("AUTH_SECRET", "")) >= 32}
    except Exception as e:
        return {"status": "degraded", "database": f"error: {e}"}


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
    result = ask(req.question.strip(), [t.model_dump() for t in req.history], inject_fault=req.inject_fault, mode=req.mode)
    qid = uuid.uuid4().hex[:12]
    result["id"] = qid
    result["conversation_id"] = req.conversation_id
    HISTORY[qid] = result
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


@app.get("/api/query/{qid}")
def get_query(qid: str, user: dict = Signed):
    if qid not in HISTORY:
        raise HTTPException(404, "Query not found (history is kept in memory per server instance).")
    return HISTORY[qid]


@app.get("/api/evaluation/suite")
def suite(user: dict = Signed):
    return evaluation.load_suite()


@app.post("/api/evaluation/run")
def run_eval(req: EvalRequest, user: dict = Signed):
    # The UI runs one test per request so long suites never hit serverless time limits.
    return evaluation.run_suite(req.ids, req.mode)


@app.get("/api/evaluation/results")
def eval_results(mode: Literal["llm", "offline"] = "llm", user: dict = Signed):
    res = evaluation.load_results(mode)
    if res is None:
        raise HTTPException(404, "No saved evaluation run yet.")
    return res
