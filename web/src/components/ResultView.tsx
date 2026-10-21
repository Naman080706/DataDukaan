import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ChevronDown } from "lucide-react";
import { AskResponse, Cell, downloadCSV, formatCell } from "../api";

type Tab = "chart" | "table" | "sql" | "steps";
const TAB_LABEL: Record<Tab, string> = { chart: "Chart", table: "Table", sql: "SQL", steps: "Agent steps" };

export default function ResultView({ r }: { r: AskResponse }) {
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
          {r.rows.length} {r.rows.length === 1 ? "row" : "rows"}
          {r.truncated ? " (first 500 shown)" : ""}, {r.attempts === 1 ? "first try" : `${r.attempts} attempts`}, {(r.latency_ms / 1000).toFixed(1)} s
        </span>
      </div>
      <div className="pt-4">
        {tab === "table" && <SortableTable columns={r.columns} rows={r.rows} />}
        {tab === "chart" && <AutoChart r={r} />}
        {tab === "sql" && <SqlInspector sql={r.sql ?? ""} />}
        {tab === "steps" && <Steps r={r} />}
      </div>
    </div>
  );
}

export function SortableTable({ columns, rows, max = 200, exportable = true }: { columns: string[]; rows: Cell[][]; max?: number; exportable?: boolean }) {
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
                    {c.replace(/_/g, " ")}
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
                    {formatCell(columns[ci], v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {exportable && (
        <button onClick={() => downloadCSV("datadukaan-result.csv", columns, rows)} className="mt-3 text-[13px] font-medium text-carbon underline-offset-2 hover:underline">
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
  const useDesc = descIdx > 0 && r.chart_type === "bar";
  const data = r.rows.map((row) => ({ label: String(useDesc ? row[descIdx] ?? row[0] : row[0]).slice(0, 30), value: row[valueIdx] as number }));
  const fmt = (v: number) => formatCell(valueCol, v);
  const compact = (v: number) => Intl.NumberFormat("en-GB", { notation: "compact" }).format(v);
  const axis = { fontSize: 12, fill: "#68657F", fontFamily: "Archivo" };
  return (
    <figure>
      <figcaption className="mb-2 text-[13px] text-muted">
        {valueCol.replace(/_/g, " ")} by {(useDesc ? r.columns[descIdx] : r.columns[0]).replace(/_/g, " ")}, picked as a {r.chart_type} chart from the shape of the result
      </figcaption>
      <ResponsiveContainer width="100%" height={Math.max(240, r.chart_type === "bar" ? data.length * 30 + 40 : 300)}>
        {r.chart_type === "line" ? (
          <LineChart data={data} margin={{ left: 4, right: 16, top: 8 }}>
            <CartesianGrid stroke="#D6DBEC" vertical={false} />
            <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: "#1E1B33" }} />
            <YAxis tick={axis} tickFormatter={compact} tickLine={false} axisLine={false} width={56} />
            <Tooltip formatter={(v: number) => fmt(v)} contentStyle={{ borderRadius: 2, borderColor: "#D6DBEC", fontFamily: "Archivo" }} />
            <Line type="monotone" dataKey="value" name={valueCol} stroke="#4338A8" strokeWidth={2.5} dot={{ r: 3, fill: "#4338A8" }} />
          </LineChart>
        ) : (
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 24 }}>
            <CartesianGrid stroke="#D6DBEC" horizontal={false} />
            <XAxis type="number" tick={axis} tickFormatter={compact} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" width={200} tick={axis} interval={0} tickLine={false} axisLine={{ stroke: "#1E1B33" }} />
            <Tooltip formatter={(v: number) => fmt(v)} cursor={{ fill: "#ECEAF8" }} contentStyle={{ borderRadius: 2, borderColor: "#D6DBEC", fontFamily: "Archivo" }} />
            <Bar dataKey="value" name={valueCol} fill="#4338A8" barSize={16} />
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
        {note && <span>Ran on a read-only connection after the validator confirmed it is a single SELECT.</span>}
        <button
          onClick={() => {
            navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="font-medium text-carbon underline-offset-2 hover:underline"
        >
          {copied ? "Copied" : "Copy SQL"}
        </button>
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  get_schema: "Loaded the table layout and counting rules",
  generate_sql: "Wrote SQL",
  inject_fault: "Demo mode broke the SQL on purpose",
  validate_sql: "Checked the SQL is safe",
  execute_readonly_sql: "Ran it on the read-only ledger",
  inspect_error: "Read the error and worked out a fix",
  summarise: "Wrote the answer from the returned rows",
  clarify: "Asked you to clarify",
  refuse: "Refused the request",
};
const STEP_COLOR: Record<string, string> = { ok: "bg-ledger", error: "bg-stamp", blocked: "bg-stamp", warn: "bg-carbon" };

function Steps({ r }: { r: AskResponse }) {
  return (
    <ol className="space-y-3">
      {r.trace.map((s, i) => (
        <li key={i} className="grid grid-cols-[28px_1fr] gap-2">
          <span className="narrow pt-0.5 text-right text-[15px] font-bold text-muted">{i + 1}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[14px] font-medium">
              <span className={`h-2 w-2 rounded-full ${STEP_COLOR[s.status] ?? "bg-muted"}`} aria-hidden />
              {STEP_LABEL[s.tool] ?? s.tool}
              <code className="font-mono text-[11.5px] font-normal text-muted">{s.tool}()</code>
            </div>
            {s.detail && <div className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted">{s.detail}</div>}
          </div>
        </li>
      ))}
      {r.model && <li className="pl-9 text-[13px] text-muted">Model used: {r.model}</li>}
    </ol>
  );
}
