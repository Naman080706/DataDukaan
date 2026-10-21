"""Minimal Gemini REST client (backend only; the key never reaches the browser)."""
import json
import os

import httpx

API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class LLMError(Exception):
    pass


def _models() -> list[str]:
    # Free-tier quotas are per model, so falling back across models spreads the load.
    primary = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
    fallbacks = os.environ.get(
        "GEMINI_FALLBACK_MODELS",
        "gemini-2.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite",
    ).split(",")
    return [primary] + [m.strip() for m in fallbacks if m.strip() and m.strip() != primary]


def generate_json(system: str, user: str, temperature: float = 0.0) -> dict:
    """Call Gemini in JSON mode, falling back to the next model on rate limits/outages."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise LLMError("GEMINI_API_KEY is not set.")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"},
    }
    last_err = None
    for model in _models():
        try:
            r = httpx.post(API_URL.format(model=model), params={"key": key}, json=body, timeout=60)
        except httpx.HTTPError as e:
            last_err = f"{model}: {e}"
            continue
        if r.status_code in (429, 500, 503, 404):
            last_err = f"{model}: HTTP {r.status_code}"
            continue
        if r.status_code != 200:
            raise LLMError(f"{model}: HTTP {r.status_code} {r.text[:200]}")
        try:
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            data = json.loads(text)
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            last_err = f"{model}: bad response ({e})"
            continue
        if isinstance(data, list) and data:
            data = data[0]
        data["_model"] = model
        return data
    raise LLMError(f"All models failed. Last error: {last_err}")
