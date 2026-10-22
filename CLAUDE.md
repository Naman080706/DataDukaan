# DataDukaan

Plain-English questions about a shop's sales records become checked, read-only SQL over DuckDB. Built for NEXAI 2026 (Text-to-SQL track). The users are shopkeepers with no technical background.

## Layout
- `api/index.py`: FastAPI app (a Vercel Python function in production, uvicorn locally). Every data endpoint uses the `Signed` dependency.
- `backend/agent.py`: the agent loop: plan → validate → execute → fix and retry (at most 2 retries) → summarise. Every step is recorded in `trace`.
- `backend/llm.py`: Gemini models first, then Groq. Keys stay on the server.
- `backend/offline.py`: the rule engine used when no AI is available. `backend/rules.py`: data and ambiguity rules shared by the prompts and the offline engine.
- `backend/validator.py`: sqlglot check (one SELECT over `transactions`, no table functions). `backend/db.py`: read-only DuckDB with external access disabled.
- `backend/cache.py`: saved question → SQL plans (seeded from `data/saved_answers.json`). `backend/auth.py`: stateless email sign-in with codes (EmailJS + HMAC).
- `backend/evaluation.py` + `eval/trap_suite.json`: the 15-question trap suite. `scripts/`: ingest, cache warming, eval and latency tools.
- `web/`: Vite + React 18 + Tailwind 3. Hash routes in `App.tsx`. `api.ts` is the only fetch layer, `speech.ts` handles voice input, `components/bits.tsx` has the React Bits-style effects.

## Run
- Backend: `pip install -r requirements.txt`, then `uvicorn api.index:app --reload` (reads `.env`; see `.env.example`).
- Frontend: `cd web && npm install && npm run dev` (proxies `/api`). Check the frontend with `npm run build`.
- Eval: `python scripts/run_eval.py`.

## Rules for changes
- **User-facing text is plain English.** Never show SQL, column names or flags in answers, assumptions or UI copy unless it sits behind a labelled "details" option.
- **Never weaken the safety layers:** `read_only=True`, `enable_external_access=false`, the validator, and the row and time limits.
- Keep the visual theme: the paper/ledger palette in `web/tailwind.config.js` and the `.sheet`/`.stamp`/`.ledger` classes in `index.css`. Fonts are Archivo and IBM Plex Mono.
- Don't add new npm or pip dependencies when a few lines will do. Effects are written in plain CSS and React.
- Serverless: in-memory state (`HISTORY`, the auth try counters, the runtime cache) is per instance and best effort only.
- After changing the counting rules, re-run the trap suite (it must stay at 15/15) and refresh `data/saved_answers.json` with `scripts/warm_cache.py`.

## Known gaps
- The sign-in try limit and resend cooldown are per instance. Real limits need a shared store such as Vercel KV or Upstash.
- Saved answers: the seed file is shared by everyone; answers saved while the app runs are kept per user (`cache.get/put(..., owner)`).
- Voice input uses the browser Web Speech API: Chrome, Edge and Safari only, and it needs an internet connection. The mic button is hidden when it isn't supported.
