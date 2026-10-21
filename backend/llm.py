"""LLM client: Gemini first, then Groq as a second provider (backend only; keys never reach the browser)."""
import json
import os

import httpx

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
RETRYABLE = (408, 429, 500, 502, 503, 504, 404)


class LLMError(Exception):
    pass


def _split(value: str) -> list[str]:
    return [m.strip() for m in value.split(",") if m.strip()]


def _gemini_models(fast: bool) -> list[str]:
    # Free-tier quotas are per model, so falling back across models spreads the load.
    primary = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
    fallbacks = _split(os.environ.get(
        "GEMINI_FALLBACK_MODELS",
        "gemini-2.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite",
    ))
    models = [primary] + [m for m in fallbacks if m != primary]
    if fast:
        lite = os.environ.get("GEMINI_FAST_MODEL", "gemini-3.5-flash-lite")
        models = [lite] + [m for m in models if m != lite]
    return models


def _groq_models() -> list[str]:
    return _split(os.environ.get("GROQ_MODELS", "llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant"))


def providers(fast: bool = False) -> list[tuple[str, str]]:
    chain = []
    if os.environ.get("GEMINI_API_KEY"):
        chain += [("gemini", m) for m in _gemini_models(fast)]
    if os.environ.get("GROQ_API_KEY"):
        chain += [("groq", m) for m in _groq_models()]
    return chain


def _call_gemini(model: str, system: str, user: str, temperature: float) -> httpx.Response:
    config = {"temperature": temperature, "responseMimeType": "application/json"}
    if model.startswith("gemini-3") and "lite" not in model:
        config["thinkingConfig"] = {"thinkingLevel": "low"}
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": config,
    }
    return httpx.post(GEMINI_URL.format(model=model), params={"key": os.environ["GEMINI_API_KEY"]}, json=body, timeout=45)


def _call_groq(model: str, system: str, user: str, temperature: float) -> httpx.Response:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {os.environ['GROQ_API_KEY']}"}
    return httpx.post(GROQ_URL, headers=headers, json=body, timeout=45)


def _text(provider: str, r: httpx.Response) -> str:
    data = r.json()
    if provider == "gemini":
        return data["candidates"][0]["content"]["parts"][0]["text"]
    return data["choices"][0]["message"]["content"]


def generate_json(system: str, user: str, temperature: float = 0.0, fast: bool = False) -> dict:
    """Call the first available model in JSON mode, falling back on rate limits or outages.

    fast=True puts a lite Gemini model first (used for summaries).
    """
    chain = providers(fast)
    if not chain:
        raise LLMError("No LLM API key is set (GEMINI_API_KEY or GROQ_API_KEY).")
    errors = []
    for provider, model in chain:
        call = _call_gemini if provider == "gemini" else _call_groq
        try:
            r = call(model, system, user, temperature)
        except httpx.HTTPError as e:
            errors.append(f"{provider}/{model}: {type(e).__name__}")
            continue
        if r.status_code in RETRYABLE or (provider == "groq" and r.status_code == 400):
            errors.append(f"{provider}/{model}: HTTP {r.status_code}")
            continue
        if r.status_code != 200:
            raise LLMError(f"{provider}/{model}: HTTP {r.status_code} {r.text[:200]}")
        try:
            data = json.loads(_text(provider, r))
        except (KeyError, IndexError, ValueError) as e:
            errors.append(f"{provider}/{model}: bad response ({type(e).__name__})")
            continue
        if isinstance(data, list) and data:
            data = data[0]
        if not isinstance(data, dict):
            errors.append(f"{provider}/{model}: response was not a JSON object")
            continue
        data["_model"] = model if provider == "gemini" else f"groq/{model}"
        return data
    raise LLMError("All AI models are unavailable right now (" + "; ".join(errors[-3:]) + ").")
