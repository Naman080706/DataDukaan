import { useEffect, useState } from "react";
import { Correction } from "../api";
import { loadCorrections, storeCorrections } from "../storage";
import { SqlInspector } from "./ResultView";

const TYPE_LABEL: Record<string, string> = {
  wrong_metric: "Wrong metric definition",
  wrong_period: "Wrong filter or period",
  wrong_grouping: "Wrong grouping",
  missing_exclusion: "Missing exclusion rule",
  other: "Something else",
};

export default function Learned({ email }: { email: string }) {
  const [items, setItems] = useState<Correction[]>(() => loadCorrections(email));

  useEffect(() => {
    const update = () => setItems(loadCorrections(email));
    window.addEventListener("datadukaan:corrections", update);
    return () => window.removeEventListener("datadukaan:corrections", update);
  }, [email]);

  function save(next: Correction[]) {
    setItems(next);
    storeCorrections(email, next);
  }

  const active = items.filter((c) => c.enabled).length;
  return (
    <div className="space-y-6">
      <section className="sheet px-5 py-7 sm:px-8">
        <h1 className="wide max-w-3xl text-[clamp(26px,3.6vw,38px)] font-extrabold leading-[1.05] tracking-tight">What I've learned from you</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Each time you said “That's not quite right” and kept the corrected answer, DataDukaan remembered the correction. When you ask a similar
          question, it uses the closest ones and says so on the answer. They are kept in this browser for your account only. Turn any of them off, or
          delete them, here.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-[14px] leading-relaxed text-muted">
          <li>The same question again reuses the corrected calculation, re-checked and re-run.</li>
          <li>A similar question (another year, another country, other words) gets the same correction applied.</li>
          <li>
            Corrections are kept narrow: one about what “sales” means doesn't change a question that says “net revenue”, and one about country
            rankings doesn't change product rankings.
          </li>
        </ol>
        <dl className="mt-6 flex flex-wrap gap-x-12 gap-y-4 border-y-[3px] border-double border-ink py-4">
          <Figure value={String(items.length)} label="corrections remembered" />
          <Figure value={String(active)} label="switched on" />
          <Figure value={String(items.reduce((n, c) => n + (c.uses ?? 0), 0))} label="times used on later questions" />
        </dl>

        {items.length === 0 ? (
          <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-muted">
            Nothing yet. Under any answer on the Ask page, choose “That's not quite right”, say what was wrong, and keep the corrected answer.
          </p>
        ) : (
          <ul className="mt-4">
            {items.map((c) => (
              <LessonItem
                key={c.id}
                c={c}
                onToggle={() => save(items.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)))}
                onDelete={() => save(items.filter((x) => x.id !== c.id))}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LessonItem({ c, onToggle, onDelete }: { c: Correction; onToggle: () => void; onDelete: () => void }) {
  const [sql, setSql] = useState(false);
  return (
    <li className={`border-b border-rule py-4 ${c.enabled ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {TYPE_LABEL[c.type] ?? c.type} · {new Date(c.created_at).toLocaleDateString("en-GB")}
            {c.uses ? ` · used ${c.uses} time${c.uses === 1 ? "" : "s"}` : ""}
          </p>
          <p className="mt-1 text-[16px] font-semibold leading-snug">{c.rule}</p>
          <p className="mt-0.5 text-[14px] italic text-muted">Learned from “{c.question}”</p>
          {c.rationale && <p className="margin-rule mt-2 text-[14px] leading-snug">{c.rationale}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-4 text-[13px]">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={c.enabled} onChange={onToggle} className="accent-carbon-deep" />
            On
          </label>
          <button onClick={onDelete} className="font-medium text-stamp underline-offset-2 hover:underline">
            Delete
          </button>
        </div>
      </div>
      <button onClick={() => setSql(!sql)} className="mt-2 text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
        {sql ? "Hide the calculations" : "Show the calculation before and after"}
      </button>
      {sql && (
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-1 text-sm font-semibold">Before</p>
            {c.original_sql ? <SqlInspector sql={c.original_sql} note={false} /> : <p className="text-[13px] text-muted">Not recorded.</p>}
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-sm font-semibold">After your correction</p>
            {c.corrected_sql && <SqlInspector sql={c.corrected_sql} note={false} />}
          </div>
        </div>
      )}
    </li>
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
