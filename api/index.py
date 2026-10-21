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

from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from backend import db, evaluation  # noqa: E402
from backend.agent import ask  # noqa: E402
from backend.rules import AMBIGUITY_RULES, DATA_RULES, DATASET_END, DATASET_START, NON_PRODUCT_CODES  # noqa: E402

app = FastAPI(title="RetailIQ API", version="1.0")

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


class EvalRequest(BaseModel):
    ids: list[str] | None = None
    mode: Literal["llm", "offline"] = "llm"


@app.get("/api/health")
def health():
    try:
        schema = db.get_schema()
        return {"status": "ok", "database": "ready", "rows": schema["row_count"],
                "llm_configured": bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GROQ_API_KEY")),
                "providers": [p for p, k in (("gemini", "GEMINI_API_KEY"), ("groq", "GROQ_API_KEY")) if os.environ.get(k)]}
    except Exception as e:
        return {"status": "degraded", "database": f"error: {e}"}


@app.get("/api/schema")
def schema():
    return db.get_schema()


@app.get("/api/rules")
def rules():
    return {"data_rules": DATA_RULES, "ambiguity_rules": AMBIGUITY_RULES, "non_product_codes": NON_PRODUCT_CODES,
            "dataset_range": [DATASET_START, DATASET_END]}


@app.post("/api/ask")
def ask_endpoint(req: AskRequest):
    result = ask(req.question.strip(), [t.model_dump() for t in req.history], inject_fault=req.inject_fault, mode=req.mode)
    qid = uuid.uuid4().hex[:12]
    result["id"] = qid
    result["conversation_id"] = req.conversation_id
    HISTORY[qid] = result
    while len(HISTORY) > HISTORY_MAX:
        HISTORY.popitem(last=False)
    return result


@app.get("/api/query/{qid}")
def get_query(qid: str):
    if qid not in HISTORY:
        raise HTTPException(404, "Query not found (history is kept in memory per server instance).")
    return HISTORY[qid]


@app.get("/api/evaluation/suite")
def suite():
    return evaluation.load_suite()


@app.post("/api/evaluation/run")
def run_eval(req: EvalRequest):
    # The UI runs one test per request so long suites never hit serverless time limits.
    return evaluation.run_suite(req.ids, req.mode)


@app.get("/api/evaluation/compare")
def eval_compare():
    return evaluation.compare_engines()


@app.get("/api/evaluation/results")
def eval_results(mode: Literal["llm", "offline"] = "llm"):
    res = evaluation.load_results(mode)
    if res is None:
        raise HTTPException(404, "No saved evaluation run yet.")
    return res
