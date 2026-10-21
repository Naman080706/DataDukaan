import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Check, ChevronDown, Copy, Download, Lock } from "lucide-react";
import { AskResponse, Cell, downloadCSV, formatCell } from "../api";

type Tab = "table" | "chart" | "sql" | "trace";

export default function ResultView({ r }: { r: AskResponse }) {
  const hasChart = r.chart_type !== "none";
  const [tab, setTab] = useState<Tab>(hasChart ? "chart" : "table");
  const tabs: Tab[] = hasChart ? ["chart", "table", "sql", "trace"] : ["table", "sql", "trace"];

  return (
    <div className="mt-3">
      {r.assumptions?.length > 0 && (
        <ul className="mb-3 space-y-0.5 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
          {r.assumptions.map((a, i) => (
            <li key={i}>• {a}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium capitalize ${tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {t === "sql" ? "SQL inspector" : t === "trace" ? `Agent trace (${r.trace.length})` : t}
          </button>
        ))}
        <span className="ml-auto pb-1 text-[11px] text-slate-400">
          {r.rows.length} row{r.rows.length === 1 ? "" : "s"}
          {r.truncated ? " (truncated)" : ""} · {r.attempts} attempt{r.attempts === 1 ? "" : "s"} · {(r.latency_ms / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="pt-3">
        {tab === "table" && <SortableTable columns={r.columns} rows={r.rows} />}
        {tab === "chart" && <AutoChart r={r} />}
        {tab === "sql" && <SqlInspector sql={r.sql ?? ""} />}
        {tab === "trace" && <Trace r={r} />}
      </div>
    </div>
  );
}

export function SortableTable({ columns, rows, max = 200 }: { columns: string[]; rows: Cell[][]; max?: number }) {
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
  if (!columns.length) return <div className="text-sm text-slate-500">No rows returned.</div>;
  return (
    <div>
      <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-50">
            <tr>
              {columns.map((c, i) => (
                <th key={c + i} onClick={() => setSort({ col: i, dir: sort?.col === i && sort.dir === -1 ? 1 : -1 })} className="cursor-pointer select-none whitespace-nowrap px-3 py-2 font-semibold text-slate-600 hover:text-slate-900">
                  {c} {sort?.col === i && <ChevronDown size={12} className={`inline ${sort.dir === 1 ? "rotate-180" : ""}`} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, max).map((row, ri) => (
              <tr key={ri} className="border-t border-slate-100 hover:bg-slate-50">
                {row.map((v, ci) => (
                  <td key={ci} className={`whitespace-nowrap px-3 py-1.5 ${typeof v === "number" ? "text-right tabular-nums" : ""}`}>
                    {formatCell(columns[ci], v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={() => downloadCSV("retailiq-result.csv", columns, rows)} className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-700">
        <Download size={14} /> Export CSV
      </button>
    </div>
  );
}

function AutoChart({ r }: { r: AskResponse }) {
  const valueIdx = r.columns.findIndex((_, i) => i > 0 && r.rows.every((row) => typeof row[i] === "number" || row[i] === null));
  if (valueIdx < 0) return null;
  const labelCol = r.columns[0];
  const valueCol = r.columns[valueIdx];
  const descIdx = r.columns.findIndex((c) => /description|name/i.test(c));
  const data = r.rows.map((row) => ({
    label: String(descIdx > 0 && r.chart_type === "bar" ? row[descIdx] ?? row[0] : row[0]).slice(0, 28),
    value: row[valueIdx] as number,
  }));
  const fmt = (v: number) => formatCell(valueCol, v);
  return (
    <div>
      <div className="mb-1 text-[11px] text-slate-400">
        Auto-selected {r.chart_type} chart: {valueCol} by {descIdx > 0 && r.chart_type === "bar" ? r.columns[descIdx] : labelCol}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        {r.chart_type === "line" ? (
          <LineChart data={data} margin={{ left: 10, right: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => Intl.NumberFormat("en-GB", { notation: "compact" }).format(v)} />
            <Tooltip formatter={(v: number) => fmt(v)} />
            <Line type="monotone" dataKey="value" stroke="#0b8571" strokeWidth={2} dot={false} />
          </LineChart>
        ) : (
          <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => Intl.NumberFormat("en-GB", { notation: "compact" }).format(v)} />
            <YAxis type="category" dataKey="label" width={170} tick={{ fontSize: 11 }} interval={0} />
            <Tooltip formatter={(v: number) => fmt(v)} />
            <Bar dataKey="value" fill="#0f9d84" radius={[0, 4, 4, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

export function SqlInspector({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <div className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className="chip bg-emerald-50 text-emerald-700"><Lock size={11} /> read-only connection</span>
        <span className="chip bg-slate-100 text-slate-600">validated: single SELECT</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="ml-auto flex items-center gap-1 text-slate-500 hover:text-slate-800"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">{sql}</pre>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-emerald-500",
  error: "bg-rose-500",
  blocked: "bg-rose-500",
  warn: "bg-amber-500",
};

function Trace({ r }: { r: AskResponse }) {
  return (
    <ol className="space-y-2">
      {r.trace.map((s, i) => (
        <li key={i} className="flex gap-3 text-xs">
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[s.status] ?? "bg-slate-400"}`} />
          <div className="min-w-0">
            <span className="font-mono font-semibold">{s.tool}()</span>{" "}
            <span className="text-slate-400">{s.status}</span>
            <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-600">{s.detail}</div>
          </div>
        </li>
      ))}
      {r.model && <li className="text-[11px] text-slate-400">model: {r.model}</li>}
    </ol>
  );
}
