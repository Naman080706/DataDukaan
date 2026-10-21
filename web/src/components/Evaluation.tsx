import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, Play, XCircle } from "lucide-react";
import { api, EvalRun, TestCase, TestResult } from "../api";
import { SortableTable, SqlInspector } from "./ResultView";

export default function Evaluation() {
  const [suite, setSuite] = useState<TestCase[]>([]);
  const [live, setLive] = useState<Record<string, TestResult>>({});
  const [saved, setSaved] = useState<EvalRun | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.suite().then(setSuite);
    api.savedResults().then(setSaved).catch(() => setSaved(null));
  }, []);

  // Run tests one request at a time so a long suite never hits serverless time limits.
  async function runAll() {
    setLive({});
    for (const t of suite) {
      setRunning(t.id);
      try {
        const run = await api.runTests([t.id]);
        setLive((prev) => ({ ...prev, [t.id]: run.results[0] }));
      } catch (e) {
        setLive((prev) => ({ ...prev, [t.id]: { ...t, passed: false, reason: `request failed: ${e}` } as TestResult }));
      }
    }
    setRunning(null);
  }

  const liveResults = Object.values(live);
  const showing: Record<string, TestResult> = liveResults.length ? live : Object.fromEntries((saved?.results ?? []).map((r) => [r.id, r]));
  const results = Object.values(showing);
  const passed = results.filter((r) => r.passed).length;
  const amb = results.filter((r) => r.check === "clarify");
  const trapCount = suite.filter((t) => ["cancellations", "returns", "ambiguity", "missing customers"].includes(t.category)).length;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-6 p-5">
        <div className="min-w-[240px] flex-1">
          <h1 className="text-xl font-semibold">Trap-question suite</h1>
          <p className="mt-1 text-sm text-slate-500">
            {suite.length} team-written questions ({trapCount} on cancellations, returns, missing customers or ambiguity). Each answer is
            compared with hand-written reference SQL run on the same database. Tolerance: £0.01 / exact counts; rankings must match the
            reference top-k.
          </p>
        </div>
        <Stat label="Passed" value={results.length ? `${passed}/${results.length}` : "–"} />
        <Stat label="Execution accuracy" value={results.length ? `${Math.round((passed / results.length) * 100)}%` : "–"} />
        <Stat label="Asked back when ambiguous" value={amb.length ? `${amb.filter((r) => r.passed).length}/${amb.length}` : "–"} />
        <button onClick={runAll} disabled={!!running || !suite.length} className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {running ? `Running ${running}…` : "Run suite live"}
        </button>
      </div>
      <div className="text-xs text-slate-500">
        {liveResults.length
          ? `Showing live run (${liveResults.length}/${suite.length} done).`
          : saved
            ? `Showing last saved run from ${new Date(saved.run_at).toLocaleString()} (eval/results.json). Click "Run suite live" to re-run against the deployed agent.`
            : "No saved run yet."}
      </div>

      <div className="card divide-y divide-slate-100">
        {suite.map((t) => {
          const r = showing[t.id];
          const isOpen = open === t.id;
          return (
            <div key={t.id}>
              <button onClick={() => setOpen(isOpen ? null : t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <ChevronRight size={16} className={`shrink-0 text-slate-400 transition ${isOpen ? "rotate-90" : ""}`} />
                <span className="w-9 shrink-0 font-mono text-xs text-slate-500">{t.id}</span>
                <span className="min-w-0 flex-1 text-sm">{t.question}</span>
                <span className="chip hidden bg-slate-100 text-slate-600 sm:inline-flex">{t.category}</span>
                {running === t.id ? (
                  <Loader2 size={18} className="animate-spin text-slate-400" />
                ) : r ? (
                  r.passed ? <CheckCircle2 size={18} className="text-emerald-600" /> : <XCircle size={18} className="text-rose-600" />
                ) : (
                  <span className="h-[18px] w-[18px] rounded-full border border-slate-200" />
                )}
              </button>
              {isOpen && (
                <div className="space-y-3 bg-slate-50/60 px-4 pb-4 pl-14 text-sm">
                  <p className="text-xs text-slate-500">
                    <b>Trap:</b> {t.challenge} · <b>Check:</b> {t.check}
                  </p>
                  {r && (
                    <p className={`text-xs ${r.passed ? "text-emerald-700" : "text-rose-700"}`}>
                      <b>{r.passed ? "PASS" : "FAIL"}:</b> {r.reason}
                      {r.agent_status && ` · agent status: ${r.agent_status}`}
                      {r.latency_ms ? ` · ${(r.latency_ms / 1000).toFixed(1)}s` : ""}
                    </p>
                  )}
                  {r?.agent_answer && r.agent_status !== "success" && <p className="text-xs italic text-slate-600">“{r.agent_answer}”</p>}
                  <div className="grid gap-3 lg:grid-cols-2">
                    {t.reference_sql && (
                      <div className="min-w-0">
                        <div className="mb-1 text-xs font-semibold">Reference SQL (hand-written)</div>
                        <SqlInspector sql={t.reference_sql} />
                        {r?.expected && <div className="mt-2"><SortableTable columns={r.expected.columns} rows={r.expected.rows} /></div>}
                      </div>
                    )}
                    {r?.agent_sql && (
                      <div className="min-w-0">
                        <div className="mb-1 text-xs font-semibold">Agent SQL</div>
                        <SqlInspector sql={r.agent_sql} />
                        {r.actual?.columns.length > 0 && <div className="mt-2"><SortableTable columns={r.actual.columns} rows={r.actual.rows} /></div>}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
