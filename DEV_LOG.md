# DEV_LOG

Key decisions, experiments, AI assistance and rejected approaches.

## 2026-10-21 (after the 18:00 kickoff)

**Data inspection**
- The workbook has two sheets: 525,461 rows and 541,910 rows, 1,067,371 in total.
- Sheet 2 repeats 2010-12-01 to 2010-12-09. That is 22,523 lines, and a set difference (`EXCEPT ALL`) confirmed they are identical to the sheet 1 lines. Kept them once, which gives 1,044,848 lines.
- Classified every line into one `line_type`: sale, cancellation (`C` invoice), stock_adjustment (negative quantity with no `C`, price 0), zero_price, or bad_debt_adjustment (`A` invoice). This turns every trap into a simple filter, for the LLM and for the reference SQL alike.
- Rejected: dropping negative quantities and NULL customers during ingestion. The PRD says not to delete silently, and "total transaction value" questions need those rows.

**Rules in one place**
- `backend/rules.py` is the single source for the schema docs, data rules and ambiguity rules. The prompt and the reference SQL use the same definitions, so the two can't drift apart.
- "Last quarter" is anchored to the end of the data (Q3 2011). The alternative was to always ask back. Rejected, because the PRD tests T09 and T10 would contradict each other. The assumption is shown on screen instead.
- "Returned most" means by units; "returned most often" means by number of return invoices. Both were added after spotting the ambiguity in T03.

**Safety**
- A parser-based validator (sqlglot) plus a DuckDB connection with `read_only=True`, `enable_external_access=false` and `lock_configuration=true`.
- Rejected: checking for the keyword `SELECT` (the PRD calls this out as insufficient).
- Tested blocks on: DELETE, multiple statements, `read_csv`, information_schema, CREATE, COPY, ATTACH, `SELECT INTO`, `getenv`, PRAGMA.

**LLM**
- Gemini over REST (httpx). The key only exists on the backend.
- Free-tier quotas are per model, and several models returned 429 during testing, so the client falls back across a list of models.
- Latency: `gemini-3.5-flash` with default thinking took 41 s end-to-end in the UI. Switching SQL planning to `thinkingLevel: low` and summaries to `gemini-3.5-flash-lite` brought it to about 6 s.
- Answers are written by a second call that sees only the result rows, which prevents invented numbers.

**Agent loop**
- Hand-rolled instead of LangGraph: fewer dependencies for a serverless bundle, and every step is visible in the trace.
- The planner returns `sql`, `clarify` or `refuse`. Execution errors go back to a fixer prompt, with at most 2 retries.
- A "Demo: inject an SQL fault" toggle corrupts one column name so the judges can watch the recovery happen. It is clearly labelled in the UI and the trace.

**Evaluation**
- 15 questions: the PRD's T01 to T12, plus a unique-customer count, "how are we doing?" and a delete request.
- Pass tolerances were fixed before the first run.
- First full run: 15/15. Saved to `eval/results.json`.
- Caveat: the team wrote the questions, so the result shows rule-following, not generalisation (also stated in the README).

**Frontend**
- React, Vite and Tailwind, with three pages: workspace, evaluation and data rules.
- The evaluation page runs one test per request so it never hits serverless time limits.
- Fixed a `useEffect` arrow that returned a value and crashed React's effect cleanup.

**Deployment**
- One Vercel project serves `web/dist` as static files and `api/index.py` as a Python function. The 16.5 MB DuckDB file is bundled with `includeFiles`.

## 2026-10-22

**Frontend redesign**
- Restyled the app as a carbon-copy bill book, chosen because the data is invoices and the product is named DataDukaan.
- Past questions sit in a counterfoil column, each answer is shown as a bill with a rubber stamp for its status, results use ledger tables, and SQL appears as a violet carbon copy.
- Fonts: Archivo with its width axis (expanded for headlines, condensed for figures). IBM Plex Mono is used only for SQL.

**Not depending on one AI service**
- Problem: free-tier Gemini returned 429 errors on several models during testing.
- Considered RAG and rejected it as the fix. Questions about 1M rows need exact aggregation in SQL; retrieving rows for the model to read would make the totals less reliable, and RAG still needs an AI model, so it doesn't help in an outage.
- Built a chain instead:
  1. Saved answers: question to verified SQL, always re-run.
  2. Gemini models.
  3. Groq models (optional key).
  4. An offline rule engine: a parser plus SQL templates using the same data rules, with template summaries. It asks back on vague questions, refuses writes, and declines what it can't parse ("last year", "this month") rather than guess.
- Trap suite now scores each engine separately, and saved answers are bypassed during tests.
  - Offline engine: 15/15. It was written with the suite in view (stated in the README).
  - AI agent: 14/15. T09 failed only because every Gemini model hit its quota mid-run.
- The AI asked back on "Which customers generated the most revenue?" and "returned most last quarter" while the cache was being warmed, even though the rules define both. Added explicit "do not ask back" lines to the ambiguity rules.

**Groq tested**
- The Llama models in the original default list are no longer offered on Groq. Switched the defaults to `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` and `openai/gpt-oss-20b`, based on the key's model list.
- With Gemini disabled, Groq wrote correct SQL, asked back on "best customers" and fixed the deliberately broken SQL on its second attempt.
- Trap suite with Groq only: 15/15. Groq's rate limits moved the run across all three models, which shows the in-provider fallback working (`eval/results_groq.json`).

**Plain language and multi-step questions**
- Rewrote every user-facing text for shop managers: no SQL, column names or flags up front. The SQL and technical details stay behind labelled options, because showing the SQL is a requirement.
- An evaluator's question, "top 5 products by revenue in the best sales month of this year", failed for two reasons: "this year" wasn't defined, and the question has two steps.
  - Defined "this year" and "last year" from the end of the data, and "best month" as highest net revenue.
  - The AI now breaks questions into steps and answers with WITH steps, guided by worked examples.
  - Backup mode now handles "in the best/worst month, quarter or country".
- Added trap tests T16 to T18 (multi-step). Every engine scored 18/18.
- Re-testing found a real gap: T13 counted customers who only cancelled. Added the rule "customers who bought = sales only".
- Added a short wait-and-retry when a provider says "try again in a few seconds"; this fixed Groq's rate-limit failures.

**Your own data**
- Users can upload CSV, Excel, JSON or Parquet. The file is loaded into DuckDB-WASM in the browser and never uploaded.
- Files that look like sales data are mapped to the same table layout, so the counting rules and backup mode apply. Any other table gets generic rules.
- The AI receives a profile of every column (blanks, distinct counts, ranges, common values) and can run up to 2 look-ups before answering. An empty answer triggers one more look and retry.
- Bugs found in testing and fixed:
  - the built-in non-product code list hid a real product (code C3) in an uploaded file
  - Excel dates were shifted by the local timezone
  - the column profile cut long values to 25 characters, so the AI matched a truncated product name

**Sign-in, landing and profile**
- Email sign-in with a 6-digit code. The backend makes the code and sends it through EmailJS, and stateless HMAC-signed challenges and sessions work on serverless hosting.
- Added landing and profile pages, plus history and saved analyses kept per user in the browser.

**Merging the team's branches**
- Merged vrisha (forecasting, action plan, claim checker, correction memory) and sr (voice input, landing effects, API hardening, per-user saved answers) into main.
- Conflicts were resolved by keeping both sides. One silent break that the merge didn't flag was fixed: overrides had been passed in the dataset-context slot.
- After merging, sr's 12-message history limit made long conversations fail. The history is now trimmed instead of rejected, and errors are shown in plain English.

**Deployment**
- The first Vercel deploys failed with FUNCTION_INVOCATION_FAILED. The logs showed Vercel had auto-detected a FastAPI app, so every page went to Python and requirements.txt was never installed. Setting "framework": null in vercel.json fixed it.
- Also removed one Python-3.12-only f-string, pinned Python 3.12 and kept large files out of the function bundle.
- Live at https://datadukaan.vercel.app

## AI assistance
Code was written with help from Claude Code (Anthropic). The team reviewed every module and can explain how it works.
