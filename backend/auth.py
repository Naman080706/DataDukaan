"""Email sign-in with one-time codes sent through EmailJS.

Stateless, so it works on serverless hosting:
- request_code() makes a 6-digit code, emails it, and returns a signed "challenge" (email + expiry + HMAC of the code).
  The code itself never reaches the browser.
- verify_code() checks the code against the challenge and returns a signed session token.
- read_token() checks a session token on each API request.
Signing uses AUTH_SECRET; EmailJS credentials come from EMAILJS_* environment variables.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time

import httpx

EMAILJS_URL = "https://api.emailjs.com/api/v1.0/email/send"
CODE_TTL_S = 10 * 60
SESSION_TTL_S = 7 * 24 * 3600
RESEND_COOLDOWN_S = 45
MAX_ATTEMPTS = 5
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[A-Za-z]{2,}$")

# Per-instance limits (best effort on serverless, where instances don't share memory).
_lock = threading.Lock()
_last_sent: dict[str, float] = {}
_attempts: dict[str, int] = {}


class AuthError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _secret() -> bytes:
    secret = os.environ.get("AUTH_SECRET")
    if not secret or len(secret) < 32:
        raise AuthError("Sign-in isn't set up on the server: AUTH_SECRET is missing or shorter than 32 characters.", 503)
    return secret.encode()


def _b64(data: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).decode().rstrip("=")


def _unb64(text: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))


def _sign(*parts: str) -> str:
    return hmac.new(_secret(), "|".join(parts).encode(), hashlib.sha256).hexdigest()


def emailjs_configured() -> bool:
    return all(os.environ.get(k) for k in ("EMAILJS_SERVICE_ID", "EMAILJS_TEMPLATE_ID", "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY"))


def _send_email(email: str, code: str) -> None:
    if not emailjs_configured():
        raise AuthError("Email sign-in isn't set up on the server: the EMAILJS_* settings are missing.", 503)
    body = {
        "service_id": os.environ["EMAILJS_SERVICE_ID"],
        "template_id": os.environ["EMAILJS_TEMPLATE_ID"],
        "user_id": os.environ["EMAILJS_PUBLIC_KEY"],
        "accessToken": os.environ["EMAILJS_PRIVATE_KEY"],
        "template_params": {"to_email": email, "passcode": code, "expires_in": f"{CODE_TTL_S // 60} minutes", "app_name": "DataDukaan"},
    }
    try:
        r = httpx.post(EMAILJS_URL, json=body, timeout=20)
    except httpx.HTTPError as e:
        raise AuthError(f"Couldn't reach the email service ({type(e).__name__}). Try again.", 502)
    if r.status_code != 200:
        raise AuthError(f"The email service refused the request: {r.text[:160]}", 502)


def request_code(email: str) -> dict:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise AuthError("Enter a valid email address.")
    _secret()  # fail before sending anything if signing isn't configured
    with _lock:
        wait = RESEND_COOLDOWN_S - (time.time() - _last_sent.get(email, 0))
        if wait > 0:
            raise AuthError(f"A code was just sent. You can ask for another in {int(wait) + 1} seconds.", 429)
        _last_sent[email] = time.time()
    code = f"{secrets.randbelow(10**6):06d}"
    exp = int(time.time()) + CODE_TTL_S
    try:
        _send_email(email, code)
    except AuthError:
        with _lock:
            _last_sent.pop(email, None)
        raise
    payload = _b64({"email": email, "exp": exp, "nonce": secrets.token_hex(8)})
    return {"challenge": f"{payload}.{_sign('code', payload, code)}", "expires_in": CODE_TTL_S}


def verify_code(challenge: str, code: str) -> dict:
    try:
        payload, sig = challenge.split(".", 1)
        data = _unb64(payload)
    except (ValueError, json.JSONDecodeError):
        raise AuthError("That sign-in request is invalid. Ask for a new code.")
    with _lock:
        tries = _attempts.get(payload, 0) + 1
        _attempts[payload] = tries
    if tries > MAX_ATTEMPTS:
        raise AuthError("Too many wrong codes. Ask for a new code.", 429)
    if data.get("exp", 0) < time.time():
        raise AuthError("That code has expired. Ask for a new one.")
    code = re.sub(r"\D", "", code or "")
    if not hmac.compare_digest(sig, _sign("code", payload, code)):
        left = MAX_ATTEMPTS - tries
        raise AuthError(f"That code isn't right. {left} {'try' if left == 1 else 'tries'} left." if left else "That code isn't right. Ask for a new code.")
    with _lock:
        _attempts.pop(payload, None)
    session = _b64({"email": data["email"], "iat": int(time.time()), "exp": int(time.time()) + SESSION_TTL_S})
    return {"token": f"{session}.{_sign('session', session)}", "email": data["email"], "expires_in": SESSION_TTL_S}


def read_token(token: str | None) -> dict:
    if not token:
        raise AuthError("Sign in to use DataDukaan.", 401)
    try:
        payload, sig = token.split(".", 1)
        data = _unb64(payload)
    except (ValueError, json.JSONDecodeError):
        raise AuthError("Your sign-in is invalid. Sign in again.", 401)
    if not hmac.compare_digest(sig, _sign("session", payload)):
        raise AuthError("Your sign-in is invalid. Sign in again.", 401)
    if data.get("exp", 0) < time.time():
        raise AuthError("Your sign-in has expired. Sign in again.", 401)
    return data
