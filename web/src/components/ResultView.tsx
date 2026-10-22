import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown } from "lucide-react";
import { AskResponse, Cell, downloadCSV, formatCell, prettyColumn } from "../api";

type Tab = "chart" | "table" | "sql" | "steps";
const TAB_LABEL: Record<Tab, string> = { chart: "Chart", table: "Table", sql: "How it was worked out", steps: "Step by step" };

export default function ResultView({ r }: { r: AskResponse }) {
  const sym = r.currency === "GBP" ? "£" : ""; // a user's own file: currency unknown, so no symbol
  const hasChart = r.chart_type !== "none";
  const [tab, setTab] = useState<Tab>(hasChart ? "chart" : "table");
  const tabs: Tab[] = hasChart ? ["chart", "table", "sql", "steps"] : ["table", "sql", "steps"];

  return (
    <div className="mt-5">
      {r.assumptions?.length > 0 && (
        <ul className="margin-rule max-w-3xl space-y-1 text-[13.5px] leading-snug text-muted">
          {r.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-rule" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="tab">
            {TAB_LABEL[t]}
          </button>
        ))}
        <span className="ml-auto pb-2 text-[13px] text-muted">
          {r.rows.length} {r.rows.length === 1 ? "result" : "results"}
          {r.truncated ? " (first 500 shown)" : ""}, answered in {r.latency_ms < 100 ? "under 0.1" : (r.latency_ms / 1000).toFixed(1)} s
        </span>
      </div>
      <div className="pt-4">
        {tab === "table" && <SortableTable columns={r.columns} rows={r.rows} currency={sym} />}
        {tab === "chart" && <AutoChart r={r} />}
        {tab === "sql" && (
          <div>
            <p className="mb-3 max-w-2xl text-[14px] leading-relaxed text-muted">
              This is the exact calculation DataDukaan ran on the sales records, written in SQL, the standard language for databases. You don't
              need to read it; it's here so anyone can check the answer.
            </p>
            <SqlInspector sql={r.sql ?? ""} />
          </div>
        )}
        {tab === "steps" && <Steps r={r} />}
      </div>
    </div>
  );
}

export function SortableTable({
  columns, rows, max = 200, exportable = true, currency = "£",
}: { columns: string[]; rows: Cell[][]; max?: number; exportable?: boolean; currency?: string }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      const x = a[sort.col], y = b[sort.col];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x > y ? 1 : -1) * sort.dir;
    });
  }, [rows, sort]);
  if (!columns.length) return <p className="text-sm text-muted">The query returned no rows.</p>;
  return (
    <div>
      <div className="max-h-[420px] overflow-auto">
        <table className="ledger w-full text-[13.5px]">
          <thead className="sticky top-0 bg-sheet">
            <tr>
              {columns.map((c, i) => (
                <th key={c + i} aria-sort={sort?.col === i ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button onClick={() => setSort({ col: i, dir: sort?.col === i && sort.dir === -1 ? 1 : -1 })} className="hover:text-ink">
                    {prettyColumn(c)}
                    {sort?.col === i && <ChevronDown size={12} className={`ml-0.5 inline ${sort.dir === 1 ? "rotate-180" : ""}`} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, max).map((row, ri) => (
              <tr key={ri}>
                {row.map((v, ci) => (
                  <td key={ci} className={typeof v === "number" ? "narrow whitespace-nowrap text-right text-[15px]" : ""}>
                    {formatCell(columns[ci], v, currency)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {exportable && (
        <button onClick={() => downloadCSV("datadukaan-result.csv", columns, rows)} className="mt-3 text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
          Download as CSV
        </button>
      )}
    </div>
  );
}

function AutoChart({ r }: { r: AskResponse }) {
  const valueIdx = r.columns.findIndex((_, i) => i > 0 && r.rows.every((row) => typeof row[i] === "number" || row[i] === null));
  if (valueIdx < 0) return null;
  const valueCol = r.columns[valueIdx];
  const descIdx = r.columns.findIndex((c) => /description|name/i.test(c));
  // Skip leading columns that are the same on every row (e.g. "best month" from a multi-step question).
  const labelIdx = Math.max(0, r.columns.findIndex((_, i) => i < valueIdx && new Set(r.rows.map((row) => String(row[i]))).size > 1));
  const useDesc = descIdx > 0 && r.chart_type === "bar";
  const data = r.rows.map((row) => ({ label: String(useDesc ? row[descIdx] ?? row[labelIdx] : row[labelIdx]).slice(0, 30), value: row[valueIdx] as number }));
  const fmt = (v: number) => formatCell(valueCol, v, r.currency === "GBP" ? "£" : "");
  const compact = (v: number) => Intl.NumberFormat("en-GB", { notation: "compact" }).format(v);
  const axis = { fontSize: 12, fill: "#6B6F66", fontFamily: "Archivo" };
  return (
    <figure>
      <figcaption className="mb-2 text-[13px] text-muted">
        {prettyColumn(valueCol)} by {prettyColumn(useDesc ? r.columns[descIdx] : r.columns[labelIdx]).toLowerCase()}
      </figcaption>
      <ResponsiveContainer width="100%" height={Math.max(240, r.chart_type === "bar" ? data.length * 30 + 40 : 300)}>
        {r.chart_type === "line" ? (
          <LineChart data={data} margin={{ left: 4, right: 16, top: 8 }}>
            <CartesianGrid stroke="#DED0AB" vertical={false} />
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: "#1D2521" }} />
            <YAxis tick={axis} tickFormatter={compact} tickLine={false} axisLine={false} width={56} />
            <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ borderRadius: 2, borderColor: "#DED0AB", fontFamily: "Archivo" }} />
            <Line type="monotone" dataKey="value" name={prettyColumn(valueCol)} stroke="#009B77" strokeWidth={2.5} dot={{ r: 3, fill: "#009B77" }} />
          </LineChart>
        ) : (
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 24 }}>
            <CartesianGrid stroke="#DED0AB" horizontal={false} />
            <XAxis type="number" tick={axis} tickFormatter={compact} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" width={200} tick={axis} interval={0} tickLine={false} axisLine={{ stroke: "#1D2521" }} />
            <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: "#B2E1D6" }} contentStyle={{ borderRadius: 2, borderColor: "#DED0AB", fontFamily: "Archivo" }} />
            <Bar dataKey="value" name={prettyColumn(valueCol)} fill="#009B77" barSize={16} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}

export function SqlInspector({ sql, note = true }: { sql: string; note?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <pre className="carbon-copy">{sql}</pre>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
        {note && <span>It only read the records; nothing was changed.</span>}
        <button
          onClick={() => {
            navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="font-medium text-carbon-deep underline-offset-2 hover:underline"
        >
          {copied ? "Copied" : "Copy SQL"}
        </button>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  get_schema: "Read the counting rules and what the data holds",
  plan_steps: "Broke the question into smaller steps",
  explore: "Looked at your data first",
  explore_run: "Checked what the data holds",
  empty_retry: "Nothing matched, so it checked how the values are stored",
  generate_sql: "Worked out how to calculate it",
  inject_fault: "Demo: broke the calculation on purpose",
  validate_sql: "Checked it only reads the data, never changes it",
  execute_readonly_sql: "Ran the calculation on the data",
  inspect_error: "Spotted the problem and fixed it",
  summarise: "Wrote the answer from the results",
  clarify: "Asked you which one you meant",
  clarify_check: "Skipped an unneeded question, because the counting rules already answer it",
  saved_answer: "Reused the working from an earlier identical question",
  offline_engine: "Used backup mode (no AI)",
  refuse: "Turned down the request",
};
const STEP_COLOR: Record<string, string> = { ok: "bg-ledger", error: "bg-stamp", blocked: "bg-stamp", warn: "bg-carbon" };

function Steps({ r }: { r: AskResponse }) {
  const [details, setDetails] = useState(false);
  return (
    <div>
      <ol className="space-y-3">
        {r.trace.map((s, i) => (
          <li key={i} className="grid grid-cols-[28px_1fr] gap-2">
            <span className="narrow pt-0.5 text-right text-[15px] font-bold text-muted">{i + 1}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-medium">
                <span className={`h-2 w-2 rounded-full ${STEP_COLOR[s.status] ?? "bg-muted"}`} aria-hidden />
                {STEP_LABEL[s.tool] ?? s.tool}
              </div>
              {!details && s.tool === "explore" && s.detail && <div className="mt-0.5 text-[13px] text-muted">{s.detail.split("\n")[0]}</div>}
              {details && s.detail && (
                <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">{s.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button onClick={() => setDetails(!details)} className="mt-4 text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
        {details ? "Hide technical details" : "Show technical details"}
      </button>
      {details && r.model && (
        <p className="mt-1 text-[13px] text-muted">{r.source === "offline" ? "Answered without AI, in backup mode." : `AI model used: ${r.model}`}</p>
      )}
    </div>
  );
}
