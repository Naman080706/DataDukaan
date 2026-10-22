"""Saved answers: question -> verified SQL plan, so repeat questions need no LLM call.

Only the plan (SQL, assumptions, title) is saved. The SQL is re-validated and
re-run on every hit, so numbers always come from the database.
Seeded from data/saved_answers.json (built by scripts/warm_cache.py), plus an
in-memory layer filled at runtime (per server instance). Runtime entries are kept per user, so one
user's AI-written wording is never shown to another; only the reviewed seed file is shared.
"""
import json
import os
import re
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_PATH = os.path.join(ROOT, "data", "saved_answers.json")
MAX_ITEMS = 500

_lock = threading.Lock()
_store: dict[str, dict] | None = None


def normalise(question: str) -> str:
    q = question.lower().replace("’", "'")
    q = re.sub(r"[^a-z0-9£' ]+", " ", q)
    return re.sub(r"\s+", " ", q).strip()


def _load() -> dict[str, dict]:
    global _store
    if _store is None:
        try:
            with open(SEED_PATH, encoding="utf-8") as f:
                _store = json.load(f)
        except (OSError, json.JSONDecodeError):
            _store = {}
    return _store


def _key(question: str, owner: str | None) -> str:
    q = normalise(question)
    return f"{owner}|{q}" if owner else q  # normalise() strips "|", so seed keys never contain it


def get(question: str, owner: str | None = None) -> dict | None:
    with _lock:
        store = _load()
        return (owner and store.get(_key(question, owner))) or store.get(_key(question, None))


def put(question: str, plan: dict, owner: str | None = None) -> None:
    with _lock:
        store = _load()
        if len(store) >= MAX_ITEMS:
            store.pop(next(iter(store)))
        store[_key(question, owner)] = {k: plan.get(k) for k in ("sql", "assumptions", "title", "model")}


def save_seed() -> None:
    with _lock, open(SEED_PATH, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in _load().items() if "|" not in k}, f, indent=2)
