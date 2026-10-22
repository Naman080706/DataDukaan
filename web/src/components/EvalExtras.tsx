import { Fragment, useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { api, ClaimSuiteRun, EvalMode, LearningRun, TestResult } from "../api";
import { AnswerText, CATEGORY_LABEL, ClaimList } from "./Evidence";
import { SqlInspector } from "./ResultView";

/** Why tests failed, by category, instead of a bare pass/fail. */
export function FailureTaxonomy({ results }: { results: TestResult[] }) {
  const failed = results.filter((r) => !r.passed);
  const misread = results.filter((r) => r.passed && r.failure_type === "misread_result");
  const counts: Record<string, number> = {};
  [...failed, ...misread].forEach((r) => {
    const label = r.failure_label ?? (r.failure_type ? r.failure_type : "Not classified");
    counts[label] = (counts[label] ?? 0) + 1;
  });
  const checked = results.filter((r) => r.answer_check);
  const grounded = checked.filter((r) => r.answer_check && ["grounded", "hypotheses"].includes(r.answer_check.status)).length;
  return (
    <div className="mt-4 grid gap-4 text-[13.5px] md:grid-cols-2">
      <div>
        <p className="font-semibold">Why tests failed</p>
        {Object.keys(counts).length === 0 ? (
          <p className="text-muted">{results.length ? "No failures to explain in this run." : "Run the tests to see this."}</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {Object.entries(counts).map(([label, n]) => (
              <li key={label}>
                <span className="narrow mr-2 text-[16px] font-bold">{n}</span>
                {label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-semibold">Written answers checked against their results</p>
        <p className="text-muted">
          {checked.length
            ? `${grounded} of ${checked.length} answers stated only what the result shows${misread.length ? `; ${misread.length} had the right numbers but misstated them` : ""}.`
            : "Not checked in this run."}
        </p>
      </div>
    </div>
  );
}

/** Extra detail for one trap test: the failure category, the SQL differences and the answer check. */
export function TestDiagnosis({ r }: { r: TestResult }) {
  return (
    <>
      {r.failure_label && (
        <p className="mt-1 text-[13.5px] text-stamp">
          Kind of mistake: {r.failure_label}
          {r.sql_differences?.length ? ` (differs from the answer key in: ${r.sql_differences.map((d) => CATEGORY_LABEL[d] ?? d).join(", ").toLowerCase()})` : ""}
        </p>
      )}
      {r.answer_check && (
        <p className="mt-1 text-[13.5px] text-muted">
          Written answer: {r.answer_check.status === "grounded" ? "every statement backed by the result" : r.answer_check.status === "hypotheses" ? "backed by the result, with an explanation marked as a hypothesis" : `not fully backed (${r.answer_check.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ").toLowerCase()})`}
          {r.answer_check.rewritten ? "; the first draft was rewritten from the figures." : "."}
        </p>
      )}
    </>
  );
}

export function ClaimSuite() {
  const [run, setRun] = useState<ClaimSuiteRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    api.claimSuite().then(setRun).finally(() => setBusy(false));
  };
  useEffect(go, []);
  return (
    <div className="sheet px-5 py-7 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <h2 className="wide text-[clamp(22px,3vw,30px)] font-extrabold leading-tight tracking-tight">Catching fluent guesses</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Every answer is split into single statements, and each one is checked against the figures and the calculation behind them. To test the
            checker, we planted mistakes in otherwise fluent answers: made-up and misread numbers, the wrong measure, the wrong year, a wrong
            ranking, a missing exclusion and explanations the figures can't prove. Correct answers are mixed in to catch false alarms.
          </p>
        </div>
        <button onClick={go} disabled={busy} className="btn-carbon flex items-center gap-2">
          {busy && <Loader2 size={15} className="animate-spin" />}
          Run the checker again
        </button>
      </div>
      {run && (
        <>
          <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-4 border-y-[3px] border-double border-ink py-4">
            <Figure value={`${run.caught}/${run.planted}`} label="planted mistakes caught" />
            <Figure value={String(run.false_alarms)} label="false alarms on correct answers" />
            <Figure value={`${run.passed}/${run.total}`} label="cases classified correctly" />
          </dl>
          <table className="ledger mt-6 w-full text-[14px]">
            <thead>
              <tr>
                <th className="w-14">Case</th>
                <th>Answer given to the checker</th>
                <th className="hidden sm:table-cell">Planted mistake</th>
                <th className="w-28 text-right">Result</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((r) => (
                <Fragment key={r.id}>
                  <tr className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="narrow align-top text-[15px] font-bold text-muted">{r.id}</td>
                    <td className="align-top">
                      <span className="flex items-start gap-1">
                        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-muted transition-transform ${open === r.id ? "rotate-90" : ""}`} />
                        <span>
                          <AnswerText text={r.answer} check={{ ...emptyCheck, claims: r.claims }} />
                        </span>
                      </span>
                    </td>
                    <td className="hidden align-top text-[13px] text-muted sm:table-cell">{r.planted}</td>
                    <td className="py-2 text-right align-top">
                      <span className={`stamp stamp-sm ${r.passed ? "text-ledger" : "text-stamp"}`}>{r.passed ? "Caught" : "Missed"}</span>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={4} className="bg-[#FCFBF7] px-3 pb-4 pt-3">
                        <p className="mb-2 text-[13.5px] text-muted">
                          Question: “{r.question}”. Expected: {r.expected.status}
                          {r.expected.categories?.length ? ` (${r.expected.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ").toLowerCase()})` : ""}; got{" "}
                          {r.got.status}
                          {r.got.categories.length ? ` (${r.got.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ").toLowerCase()})` : ""}.
                        </p>
                        <ClaimList claims={r.claims} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const ROLE_LABEL = { repeat: "Same question", paraphrase: "Similar question", control: "Must not change" };

/** Correction memory: does one correction fix repeated and similar questions, without changing unrelated ones? */
export function LearningSuite({ mode }: { mode: EvalMode }) {
  const [saved, setSaved] = useState<LearningRun | null>(null);
  const [live, setLive] = useState<LearningRun | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setLive(null);
    api.savedLearning(mode).then(setSaved).catch(() => setSaved(null));
  }, [mode]);

  // One scenario per request keeps each call well inside serverless time limits.
  async function runAll() {
    const suite = await api.learningSuite();
    let acc: LearningRun | null = null;
    for (const sc of suite) {
      setRunning(sc.id);
      try {
        const one = await api.runLearning([sc.id], mode);
        acc = acc
          ? { ...one, ...sumRuns(acc, one), scenarios: [...acc.scenarios, ...one.scenarios] }
          : one;
        setLive(acc);
      } catch {
        // keep the scenarios that finished
      }
    }
    setRunning(null);
  }

  const run = live ?? saved;
  return (
    <div className="sheet px-5 py-7 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <h2 className="wide text-[clamp(22px,3vw,30px)] font-extrabold leading-tight tracking-tight">Learning from corrections</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Four shop-specific habits that the standard rules get “wrong”. For each, we give one correction through “That's not quite right”, then ask
            the same question, similar questions, and a question the correction must not change, with and without the correction remembered.
          </p>
        </div>
        <button onClick={runAll} disabled={!!running} className="btn-carbon flex items-center gap-2">
          {running && <Loader2 size={15} className="animate-spin" />}
          {running ? `Running ${running}` : "Run the learning tests now"}
        </button>
      </div>
      {run ? (
        <>
          <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-4 border-y-[3px] border-double border-ink py-4">
            <Figure value={`${run.learn_before}/${run.learn_total}`} label="similar questions right before the correction" />
            <Figure value={`${run.learn_after}/${run.learn_total}`} label="right after it was remembered" />
            <Figure value={`${run.control_after}/${run.control_total}`} label="unrelated questions left unchanged" />
          </dl>
          <p className="mt-3 text-[13px] text-muted">
            {live ? "Live run." : `Showing the run saved on ${new Date(run.run_at).toLocaleString("en-GB")}.`}
            {mode === "offline" ? " Backup mode applies corrections exactly, so this run is the same every time." : ""}
          </p>
          <table className="ledger mt-4 w-full text-[14px]">
            <tbody>
              {run.scenarios.map((sc) => (
                <Fragment key={sc.id}>
                  <tr className="cursor-pointer" onClick={() => setOpen(open === sc.id ? null : sc.id)}>
                    <td className="narrow w-14 align-top text-[15px] font-bold text-muted">{sc.id}</td>
                    <td className="align-top">
                      <span className="flex items-start gap-1">
                        <ChevronRight size={15} className={`mt-0.5 shrink-0 text-muted transition-transform ${open === sc.id ? "rotate-90" : ""}`} />
                        <span>
                          {sc.pattern}
                          <span className="block text-[13px] text-muted">
                            Taught on “{sc.teach.question}”: {sc.learned?.rule ?? "the correction could not be worked out"}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="narrow w-24 text-right align-top text-[15px]">
                      {sc.probes.filter((p) => p.role !== "control" && p.after.passed).length}/{sc.probes.filter((p) => p.role !== "control").length}
                    </td>
                  </tr>
                  {open === sc.id && (
                    <tr>
                      <td colSpan={3} className="bg-[#FCFBF7] px-3 pb-4 pt-3">
                        <table className="w-full text-[13.5px]">
                          <tbody>
                            {sc.probes.map((p) => (
                              <tr key={p.question}>
                                <td className="py-1 pr-3 text-muted">{ROLE_LABEL[p.role]}</td>
                                <td className="py-1 pr-3">{p.question}</td>
                                <td className="whitespace-nowrap py-1 text-right">
                                  <Mark ok={p.before.passed} /> → <Mark ok={p.after.passed} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {sc.learned?.corrected_sql && (
                          <div className="mt-3 grid gap-4 lg:grid-cols-2">
                            <div className="min-w-0">
                              <p className="mb-1 text-sm font-semibold">Before the correction</p>
                              <SqlInspector sql={sc.learned.original_sql ?? ""} note={false} />
                            </div>
                            <div className="min-w-0">
                              <p className="mb-1 text-sm font-semibold">After</p>
                              <SqlInspector sql={sc.learned.corrected_sql} note={false} />
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="mt-4 text-[13px] text-muted">No saved run for this mode yet. Run the learning tests to see results.</p>
      )}
    </div>
  );
}

function sumRuns(a: LearningRun, b: LearningRun) {
  return {
    learn_total: a.learn_total + b.learn_total, learn_before: a.learn_before + b.learn_before, learn_after: a.learn_after + b.learn_after,
    control_total: a.control_total + b.control_total, control_before: a.control_before + b.control_before, control_after: a.control_after + b.control_after,
  };
}

function Mark({ ok }: { ok: boolean }) {
  return <span className={`font-semibold ${ok ? "text-ledger" : "text-stamp"}`}>{ok ? "right" : "wrong"}</span>;
}

const emptyCheck = { status: "grounded" as const, counts: { supported: 0, contradicted: 0, unsupported: 0, hypothesis: 0 }, grounded_share: null, categories: [] };

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dd className="narrow text-[44px] font-extrabold leading-none">{value}</dd>
      <dt className="mt-1 text-[13px] text-muted">{label}</dt>
    </div>
  );
}
