import { currentToken, signOut } from "./auth";

export type Cell = string | number | boolean | null;

export interface TraceStep {
  tool: string;
  status: "ok" | "error" | "blocked" | "warn";
  detail: string;
}

export type ClaimVerdict = "supported" | "contradicted" | "unsupported" | "hypothesis";

export interface Claim {
  id: number;
  type: string;
  text: string;
  start: number;
  end: number;
  verdict: ClaimVerdict;
  evidence: string;
  category: string | null;
}

export interface ClaimCheck {
  status: "grounded" | "hypotheses" | "unsupported" | "contradicted";
  claims: Claim[];
  counts: Record<ClaimVerdict, number>;
  grounded_share: number | null;
  categories: string[];
}

export interface ForecastPoint {
  period: string;
  value: number;
  lo80: number;
  hi80: number;
  lo95: number;
  hi95: number;
}

export type ForecastMetric = "net_revenue" | "units_sold" | "orders" | "returned_units" | "return_value";
export type ForecastScope = "total" | "country" | "product";

export interface ForecastResult {
  metric: ForecastMetric;
  metric_label: string;
  unit: "gbp" | "count";
  scope: ForecastScope;
  key: string | null;
  label: string;
  horizon: number;
  sql: string;
  notes: string[];
  history: { period: string; value: number }[];
  forecast: ForecastPoint[];
  total: { value: number; lo80: number; hi80: number };
  model: { name: string; description: string };
  backtest: {
    mape: number;
    points: { period: string; actual: number; predicted: number }[];
    models: { name: string; description: string; mape: number }[];
  };
  capped: { period: string; value: number }[];
}

export type Severity = "Critical" | "Watch" | "Opportunity";

export interface Action {
  rank: number;
  severity: Severity;
  rule: string;
  title: string;
  detail: string;
  evidence: string[];
  at_stake_gbp: number;
  priority: number;
  entity: { kind: "product" | "country"; key: string; label: string };
}

export interface Diagnosis {
  kind: "product" | "country";
  key: string;
  label: string;
  status: "Critical" | "Watch" | "Healthy";
  reasons: string[];
  rules: string[];
  net_revenue_gbp: number;
  return_rate?: number;
  return_value_share?: number;
  change_vs_last_year?: number | null;
}

export interface ActionPlan {
  period: string;
  benchmarks: { product_return_rate: number; return_value_share: number; period: string };
  rules: { id: string; applies_to: string; name: string; rule: string }[];
  counts: { Critical: number; Watch: number; Healthy: number };
  diagnoses: Diagnosis[];
  actions: Action[];
  total_actions: number;
}

export type CorrectionType = "wrong_metric" | "wrong_period" | "wrong_grouping" | "missing_exclusion" | "other";

export interface Correction {
  id: string;
  created_at: string;
  type: CorrectionType;
  choice: string | null;
  choice_label: string | null;
  question: string;
  original_sql: string | null;
  corrected_sql: string | null;
  rule: string;
  rationale: string;
  override: Record<string, unknown>;
  term: string | null;
  title: string;
  assumptions: string[];
  enabled: boolean;
  uses?: number;
}

export interface CorrectionOptions {
  types: Record<string, string>;
  choices: Record<string, { key: string; label: string }[]>;
}

export interface AskResponse {
  id: string;
  status: "success" | "clarification" | "refused" | "blocked" | "error" | "unavailable";
  source: "saved" | "ai" | "offline" | "tools" | "learned" | null;
  kind?: "forecast" | "actions";
  forecast?: ForecastResult;
  action_plan?: ActionPlan;
  claims?: ClaimCheck;
  draft_answer?: string;
  draft_claims?: ClaimCheck;
  applied_corrections?: { id: string; question: string; rule: string; type: CorrectionType; score: number }[];
  clarification_required: boolean;
  question: string;
  answer: string;
  options?: string[];
  sql: string | null;
  columns: string[];
  rows: Cell[][];
  truncated?: boolean;
  currency: string;
  chart_type: "bar" | "line" | "forecast" | "none";
  assumptions: string[];
  trace: TraceStep[];
  attempts: number;
  latency_ms: number;
  model: string | null;
  title?: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  sql?: string | null;
}

export interface TestCase {
  id: string;
  question: string;
  category: string;
  check: string;
  challenge: string;
  reference_sql?: string;
}

export interface TestResult extends TestCase {
  passed: boolean;
  reason: string;
  failure_type?: string | null;
  failure_label?: string | null;
  sql_differences?: string[];
  answer_check?: { status: ClaimCheck["status"]; categories: string[]; rewritten: boolean; draft_answer?: string } | null;
  expected: { columns: string[]; rows: Cell[][] } | null;
  actual: { columns: string[]; rows: Cell[][] };
  agent_status: string;
  agent_sql: string | null;
  agent_answer: string;
  attempts: number;
  latency_ms: number;
  model: string | null;
}

export type EvalMode = "llm" | "offline";


export interface EvalRun {
  mode?: EvalMode;
  run_at: string;
  total: number;
  passed: number;
  execution_accuracy: number;
  clarification_rate: number | null;
  failure_types?: Record<string, number>;
  results: TestResult[];
}

export interface ClaimSuiteRun {
  total: number;
  passed: number;
  caught: number;
  planted: number;
  false_alarms: number;
  categories: Record<string, string>;
  results: {
    id: string;
    planted: string;
    question: string;
    answer: string;
    expected: { status: string; categories?: string[] };
    got: { status: string; categories: string[] };
    claims: Claim[];
    passed: boolean;
  }[];
}

export interface ProbeResult {
  role: "repeat" | "paraphrase" | "control";
  question: string;
  before: { passed: boolean; reason: string; sql: string | null; applied: string[] };
  after: { passed: boolean; reason: string; sql: string | null; applied: string[] };
}

export interface LearningScenario {
  id: string;
  type: CorrectionType;
  pattern: string;
  teach: { question: string; choice: string; rationale: string };
  learned: Correction | null;
  probes: ProbeResult[];
}

export interface LearningRun {
  mode: EvalMode;
  run_at: string;
  learn_total: number;
  learn_before: number;
  learn_after: number;
  control_total: number;
  control_before: number;
  control_after: number;
  scenarios: LearningScenario[];
}

export interface CorrectResponse {
  status: string;
  answer?: string;
  correction?: Correction;
  result?: AskResponse;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    let detail = (await res.text()).slice(0, 300);
    try {
      const parsed = JSON.parse(detail).detail;
      detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    } catch {
      // keep the raw text
    }
    // An expired or invalid session sends the user back to sign in.
    if (res.status === 401 && !path.startsWith("/api/auth/")) signOut();
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export const api = {
  health: () =>
    req<{ status: string; database: string; rows?: number; llm_configured?: boolean; providers?: string[]; email_sign_in?: boolean }>("/api/health"),
  requestCode: (email: string) => req<{ challenge: string; expires_in: number }>("/api/auth/request-code", { email }),
  verifyCode: (challenge: string, code: string) => req<{ token: string; email: string; expires_in: number }>("/api/auth/verify", { challenge, code }),
  schema: () => req<{ tables: { name: string; columns: { name: string; type: string }[] }[]; row_count: number; date_range: string[] }>("/api/schema"),
  rules: () => req<{ data_rules: string; ambiguity_rules: string; non_product_codes: string[]; dataset_range: string[] }>("/api/rules"),
  ask: (question: string, history: Turn[], conversation_id: string, inject_fault = false, mode: "auto" | "offline" = "auto", corrections: Correction[] = []) =>
    req<AskResponse>("/api/ask", { question, history, conversation_id, inject_fault, mode, corrections }),
  correctionOptions: () => req<CorrectionOptions>("/api/corrections/options"),
  correct: (body: { question: string; original_sql: string | null; type: CorrectionType; choice: string | null; rationale: string; history: Turn[]; mode: "auto" | "offline" }) =>
    req<CorrectResponse>("/api/correct", body),
  forecast: (metric: ForecastMetric, scope: ForecastScope, key: string | null, horizon: number) =>
    req<ForecastResult>("/api/forecast", { metric, scope, key, horizon }),
  forecastEntities: () =>
    req<{ countries: string[]; products: { code: string; description: string }[]; metrics: Record<ForecastMetric, { label: string; unit: string }> }>("/api/forecast/entities"),
  actions: () => req<ActionPlan>("/api/actions"),
  claimSuite: () => req<ClaimSuiteRun>("/api/evaluation/claims"),
  learningSuite: () => req<{ id: string; type: CorrectionType; pattern: string }[]>("/api/evaluation/learning/suite"),
  runLearning: (ids: string[], mode: EvalMode) => req<LearningRun>("/api/evaluation/learning", { ids, mode }),
  savedLearning: (mode: EvalMode) => req<LearningRun>(`/api/evaluation/learning/results?mode=${mode}`),
  suite: () => req<TestCase[]>("/api/evaluation/suite"),
  runTests: (ids: string[], mode: EvalMode, check_answers = false) => req<EvalRun>("/api/evaluation/run", { ids, mode, check_answers }),
  // A user's own dataset: the server plans/fixes/summarises, the browser runs the SQL.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasetPlan: (question: string, history: Turn[], dataset: unknown, mode: "auto" | "offline", observations: unknown[] = []) =>
    req<any>("/api/dataset/plan", { question, history, dataset, mode, observations }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  datasetFix: (question: string, sql: string, error: string, dataset: unknown) => req<any>("/api/dataset/fix", { question, sql, error, dataset }),
  datasetSummarise: (question: string, title: string, assumptions: string[], columns: string[], rows: Cell[][], source: "ai" | "offline", total_rows = rows.length) =>
    req<{ answer: string; chart_type: "bar" | "line" | "none"; summary_by: string }>("/api/dataset/summarise", { question, title, assumptions, columns, rows, source, total_rows }),
  savedResults: (mode: EvalMode) => req<EvalRun>(`/api/evaluation/results?mode=${mode}`),
};

export function toCSV(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function downloadCSV(name: string, columns: string[], rows: Cell[][]) {
  const blob = new Blob([toCSV(columns, rows)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const MONEY_HINT = /(revenue|value|gbp|sales|amount|price|spend|total)/i;

export function formatCell(col: string, v: Cell, currency = "£"): string {
  if (v === null) return "—";
  if (typeof v === "number") {
    if (MONEY_HINT.test(col) && !/(units|count|qty|quantity|invoices|orders|customers)/i.test(col))
      return currency + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }
  return String(v);
}

// Turn database column names into words a shop manager would use.
const COLUMN_WORDS: Record<string, string> = {
  stock_code: "Product code",
  description: "Product",
  customer_id: "Customer ID",
  country: "Country",
  invoice: "Invoice",
  invoice_date: "Date",
  line_value: "Line value",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  best_month: "Best month",
  worst_month: "Worst month",
  best_country: "Best country",
  worst_country: "Worst country",
  best_quarter: "Best quarter",
  worst_quarter: "Worst quarter",
};

export function prettyColumn(col: string): string {
  if (COLUMN_WORDS[col]) return COLUMN_WORDS[col];
  const money = /_gbp$/i.test(col);
  const words = col.replace(/_(gbp|value)$/i, "").replace(/_/g, " ").trim();
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return money ? `${text} (£)` : text;
}
