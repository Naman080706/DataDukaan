// The question loop for a user's own file: the server plans, fixes and summarises; the SQL runs here in the browser.
import { api, AskResponse, Cell, TraceStep, Turn } from "./api";
import type { DatasetProfile } from "./localdb";
import { runQuery } from "./localdb";

const MAX_RETRIES = 2;
const MAX_EXPLORES = 2;

function datasetInfo(p: DatasetProfile) {
  return {
    kind: p.kind, source: p.source, columns: p.columns.slice(0, 200), sample_rows: p.sample_rows.slice(0, 5),
    row_count: p.row_count, date_range: p.date_range, countries: p.countries.slice(0, 400),
    column_stats: (p.column_stats ?? []).slice(0, 120),
  };
}

type Observation = { sql: string; why: string; columns: string[]; rows: Cell[][]; error: string | null };

export async function askLocal(
  question: string, history: Turn[], profile: DatasetProfile, injectFault: boolean, mode: "auto" | "offline",
  prior?: { observations: Observation[]; trace: TraceStep[] },
): Promise<AskResponse> {
  const t0 = performance.now();
  const ds = datasetInfo(profile);
  const base: AskResponse = {
    id: crypto.randomUUID(), status: "error", source: "ai", clarification_required: false, question, answer: "", sql: null,
    columns: [], rows: [], currency: "", chart_type: "none", assumptions: [], trace: [], attempts: 0, latency_ms: 0, model: null,
  };
  const done = (r: Partial<AskResponse>) => ({ ...base, ...r, latency_ms: Math.round(performance.now() - t0) });

  // The AI may look at the data first (up to 2 small look-ups run here), then plan the answer with what it saw.
  const trace: TraceStep[] = [...(prior?.trace ?? [])];
  const observations: Observation[] = [...(prior?.observations ?? [])];
  let plan = await api.datasetPlan(question, history, ds, mode, observations);
  trace.push(...(plan.trace ?? []));
  while (plan.status === "explore" && observations.length < MAX_EXPLORES) {
    try {
      const look = await runQuery(plan.sql, 50);
      const rows = look.rows.slice(0, 30).map((r) => r.map((v) => (typeof v === "string" ? v.slice(0, 60) : v)));
      observations.push({ sql: plan.sql, why: plan.why ?? "", columns: look.columns, rows, error: null });
      trace.push({ tool: "explore_run", status: "ok", detail: `look-up: ${look.rows.length} rows in ${look.elapsed_ms} ms, in your browser` });
    } catch (e) {
      const err = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
      observations.push({ sql: plan.sql, why: plan.why ?? "", columns: [], rows: [], error: err });
      trace.push({ tool: "explore_run", status: "error", detail: `look-up failed: ${err}` });
    }
    plan = await api.datasetPlan(question, history, ds, mode, observations);
    trace.push(...(plan.trace ?? []).filter((t: TraceStep) => t.tool !== "get_schema"));
  }
  const common = { trace, source: plan.source ?? "ai", model: plan.model ?? null };
  if (plan.status !== "run") {
    return done({ ...common, status: plan.status, answer: plan.answer ?? "", options: plan.options ?? [], clarification_required: plan.status === "clarification" });
  }

  let sql: string = plan.sql;
  if (injectFault) {
    const col = profile.columns.map((c) => c.name).find((n) => sql.includes(n));
    sql = col ? sql.replace(col, `${col}_x`) : sql.replace("SELECT", "SELEC");
    trace.push({ tool: "inject_fault", status: "warn", detail: "Demo mode: a column name was deliberately corrupted to show error recovery" });
  }

  let result: { columns: string[]; rows: Cell[][]; truncated: boolean; elapsed_ms: number } | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attempts = attempt + 1;
    try {
      result = await runQuery(sql);
      trace.push({ tool: "execute_readonly_sql", status: "ok", detail: `${result.rows.length} rows in ${result.elapsed_ms} ms, in your browser` });
      break;
    } catch (e) {
      const err = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 400);
      if (attempt === MAX_RETRIES) {
        trace.push({ tool: "execute_readonly_sql", status: "error", detail: err });
        return done({ ...common, sql, attempts, answer: `DataDukaan couldn't work this out after ${MAX_RETRIES + 1} tries. Try asking it a different way.` });
      }
      const fix = await api.datasetFix(question, sql, err, ds);
      trace.push(...(fix.trace ?? []));
      if (fix.status !== "run") return done({ ...common, sql, attempts, status: fix.status === "blocked" ? "blocked" : "error", answer: fix.answer ?? "" });
      sql = fix.sql;
    }
  }
  if (!result) return done({ ...common, sql, attempts });

  // Nothing matched: usually a value spelled differently from how it's stored. Tell the AI and let it look and retry once.
  if (result.rows.length === 0 && !prior && common.source !== "offline") {
    trace.push({ tool: "empty_retry", status: "warn", detail: "Nothing matched, so DataDukaan checked how the values are actually stored" });
    const empty: Observation = {
      sql, why: "The first answer came back empty", columns: result.columns, rows: [],
      error: "No rows matched. A filter value probably doesn't match how the data is stored: explore to find the stored value.",
    };
    return askLocal(question, history, profile, false, mode, { observations: [...observations, empty], trace });
  }

  const summary = await api
    .datasetSummarise(question, plan.title ?? "", plan.assumptions ?? [], result.columns, result.rows.slice(0, 20), common.source === "offline" ? "offline" : "ai", result.rows.length)
    .catch(() => null);
  trace.push({ tool: "summarise", status: summary ? "ok" : "error", detail: summary?.summary_by === "ai" ? "answer written from the returned rows only" : "answer built from the returned rows by a template (no AI)" });
  return done({
    ...common, status: "success", sql, attempts, columns: result.columns, rows: result.rows, truncated: result.truncated,
    assumptions: plan.assumptions ?? [], title: plan.title ?? "", answer: summary?.answer ?? `${result.rows.length} results.`,
    chart_type: summary?.chart_type ?? "none",
  });
}
