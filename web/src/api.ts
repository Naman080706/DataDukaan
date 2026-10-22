import { currentToken, signOut } from "./auth";

export type Cell = string | number | boolean | null;

export interface TraceStep {
  tool: string;
  status: "ok" | "error" | "blocked" | "warn";
  detail: string;
}

export interface AskResponse {
  id: string;
  status: "success" | "clarification" | "refused" | "blocked" | "error" | "unavailable";
  source: "saved" | "ai" | "offline" | null;
  clarification_required: boolean;
  question: string;
  answer: string;
  options?: string[];
  sql: string | null;
  columns: string[];
  rows: Cell[][];
  truncated?: boolean;
  currency: string;
  chart_type: "bar" | "line" | "none";
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
  results: TestResult[];
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
  ask: (question: string, history: Turn[], conversation_id: string, inject_fault = false, mode: "auto" | "offline" = "auto") =>
    req<AskResponse>("/api/ask", { question, history, conversation_id, inject_fault, mode }),
  suite: () => req<TestCase[]>("/api/evaluation/suite"),
  runTests: (ids: string[], mode: EvalMode) => req<EvalRun>("/api/evaluation/run", { ids, mode }),
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
