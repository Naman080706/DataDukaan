export type Cell = string | number | boolean | null;

export interface TraceStep {
  tool: string;
  status: "ok" | "error" | "blocked" | "warn";
  detail: string;
}

export interface AskResponse {
  id: string;
  status: "success" | "clarification" | "refused" | "blocked" | "error";
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

export interface EvalRun {
  run_at: string;
  total: number;
  passed: number;
  execution_accuracy: number;
  clarification_rate: number | null;
  results: TestResult[];
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const api = {
  health: () => req<{ status: string; database: string; rows?: number; llm_configured?: boolean }>("/api/health"),
  schema: () => req<{ tables: { name: string; columns: { name: string; type: string }[] }[]; row_count: number; date_range: string[] }>("/api/schema"),
  rules: () => req<{ data_rules: string; ambiguity_rules: string; non_product_codes: string[]; dataset_range: string[] }>("/api/rules"),
  ask: (question: string, history: Turn[], conversation_id: string, inject_fault = false) =>
    req<AskResponse>("/api/ask", { question, history, conversation_id, inject_fault }),
  suite: () => req<TestCase[]>("/api/evaluation/suite"),
  runTests: (ids: string[]) => req<EvalRun>("/api/evaluation/run", { ids }),
  savedResults: () => req<EvalRun>("/api/evaluation/results"),
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

export function formatCell(col: string, v: Cell): string {
  if (v === null) return "—";
  if (typeof v === "number") {
    if (MONEY_HINT.test(col) && !/(units|count|qty|quantity|invoices|orders|customers)/i.test(col))
      return "£" + v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }
  return String(v);
}
