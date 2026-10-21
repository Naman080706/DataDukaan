import { Fragment, useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { api, EvalMode, EvalRun, TestCase, TestResult } from "../api";
import { SortableTable, SqlInspector } from "./ResultView";
import EngineComparison from "./EngineComparison";

export default function Evaluation() {
  const [suite, setSuite] = useState<TestCase[]>([]);
  const [live, setLive] = useState<Record<string, TestResult>>({});
  const [saved, setSaved] = useState<EvalRun | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<EvalMode>("llm");

  useEffect(() => {
    api.suite().then(setSuite);
  }, []);
  useEffect(() => {
    setLive({});
    setSaved(null);
    api
      .savedResults(mode)
      .then(setSaved)
      .catch(() => setSaved(null));
  }, [mode]);

  // One request per test keeps each call well inside serverless time limits.
  async function runAll() {
    setLive({});
    for (const t of suite) {
      setRunning(t.id);
      try {
        const run = await api.runTests([t.id], mode);
        setLive((prev) => ({ ...prev, [t.id]: run.results[0] }));
      } catch (e) {
        setLive((prev) => ({
          ...prev,
          [t.id]: {
            ...t,
            passed: false,
            reason: `request failed: ${e}`,
          } as TestResult,
        }));
      }
    }
    setRunning(null);
  }

  const liveCount = Object.keys(live).length;
  const showing: Record<string, TestResult> = liveCount ? live : Object.fromEntries((saved?.results ?? []).map((r) => [r.id, r]));
  const results = Object.values(showing);
  const passed = results.filter((r) => r.passed).length;
  const amb = results.filter((r) => r.check === "clarify");

  return (
    <div className="space-y-6">
      <EngineComparison />
      <div className="sheet px-5 py-7 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="wide text-[clamp(26px,3.6vw,38px)] font-extrabold leading-[1.05] tracking-tight">
              {suite.length || 15} questions written to trip the agent up
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              Cancelled invoices, returns, customers without an ID, vague wording and a request to delete data. Each answer is checked
              against SQL we wrote by hand: totals must match to the penny, rankings must match the reference top 5, and vague questions
              must be asked back.
            </p>
          </div>
          <button onClick={runAll} disabled={!!running || !suite.length} className="btn-carbon flex items-center gap-2">
            {running && <Loader2 size={15} className="animate-spin" />}
            {running ? `Running ${running}` : `Run all ${suite.length} tests now`}
          </button>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2" role="tablist" aria-label="What to test">
          <span className="text-sm font-semibold">Testing</span>
          {(["llm", "offline"] as EvalMode[]).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} disabled={!!running} onClick={() => setMode(m)} className="tab">
              {m === "llm" ? "The AI agent" : "The offline engine (no AI)"}
            </button>
          ))}
        </div>
        {mode === "offline" && (
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">
            The offline engine is the backup for when every AI model is unavailable. It was written with these questions in view, so a high
            score here shows it covers them, not that it handles any wording.
          </p>
        )}

        <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-4 border-y-[3px] border-double border-ink py-4">
          <Figure value={results.length ? `${passed}/${results.length}` : "–"} label="tests passed" />
          <Figure value={results.length ? `${Math.round((passed / results.length) * 100)}%` : "–"} label="execution accuracy" />
          <Figure value={amb.length ? `${amb.filter((r) => r.passed).length}/${amb.length}` : "–"} label="vague questions asked back" />
        </dl>
        <p className="mt-3 text-[13px] text-muted">
          {liveCount
            ? `Live run in progress or just finished: ${liveCount} of ${suite.length} done.`
            : saved
              ? `Showing the run saved on ${new Date(saved.run_at).toLocaleString("en-GB")}. Running the tests again calls the live agent, and results can vary slightly between runs.`
              : "No saved run yet. Run the tests to see results."}
        </p>

        <table className="ledger mt-6 w-full text-[14px]">
          <thead>
            <tr>
              <th className="w-14">Test</th>
              <th>Question</th>
              <th className="hidden sm:table-cell">What it checks</th>
              <th className="w-28 text-right">Result</th>
            </tr>
          </thead>
          <tbody>
            {suite.map((t) => {
              const r = showing[t.id];
              const isOpen = open === t.id;
              return (
                <Fragment key={t.id}>
                  <tr className="cursor-pointer" onClick={() => setOpen(isOpen ? null : t.id)}>
                    <td className="narrow align-top text-[15px] font-bold text-muted">{t.id}</td>
                    <td className="align-top">
                      <button className="flex items-start gap-1 text-left" aria-expanded={isOpen}>
                        <ChevronRight
                          size={15}
                          className={`mt-0.5 shrink-0 text-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
                        />
                        {t.question}
                      </button>
                    </td>
                    <td className="hidden align-top text-[13px] text-muted sm:table-cell">{t.category}</td>
                    <td className="py-2 text-right align-top">
                      {running === t.id ? (
                        <Loader2 size={16} className="ml-auto animate-spin text-carbon" />
                      ) : r ? (
                        <span className={`stamp stamp-sm ${r.passed ? "text-ledger" : "text-stamp"}`}>{r.passed ? "Pass" : "Fail"}</span>
                      ) : (
                        <span className="text-[13px] text-muted">Not run</span>
                      )}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4} className="bg-[#FAFAFD] px-3 pb-5 pt-3">
                        <p className="max-w-3xl text-[13.5px] text-muted">The trap: {t.challenge}</p>
                        {r && (
                          <p className={`mt-1 text-[13.5px] ${r.passed ? "text-ledger" : "text-stamp"}`}>
                            {r.passed ? "Passed" : "Failed"}: {r.reason}
                            {r.latency_ms ? `, ${(r.latency_ms / 1000).toFixed(1)} s` : ""}
                          </p>
                        )}
                        {r?.agent_answer && r.agent_status !== "success" && (
                          <p className="mt-2 max-w-3xl text-[14px] italic">“{r.agent_answer}”</p>
                        )}
                        <div className="mt-4 grid gap-6 lg:grid-cols-2">
                          {t.reference_sql && (
                            <div className="min-w-0">
                              <p className="mb-1.5 text-sm font-semibold">Our hand-written SQL</p>
                              <SqlInspector sql={t.reference_sql} note={false} />
                              {r?.expected && (
                                <div className="mt-3">
                                  <SortableTable columns={r.expected.columns} rows={r.expected.rows} exportable={false} />
                                </div>
                              )}
                            </div>
                          )}
                          {r?.agent_sql && (
                            <div className="min-w-0">
                              <p className="mb-1.5 text-sm font-semibold">The agent's SQL</p>
                              <SqlInspector sql={r.agent_sql} note={false} />
                              {r.actual?.columns.length > 0 && (
                                <div className="mt-3">
                                  <SortableTable columns={r.actual.columns} rows={r.actual.rows} exportable={false} />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dd className="narrow text-[44px] font-extrabold leading-none">{value}</dd>
      <dt className="mt-1 text-[13px] text-muted">{label}</dt>
    </div>
  );
}
