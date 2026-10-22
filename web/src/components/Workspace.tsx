import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { api, AskResponse, Correction, Turn } from "../api";
import ResultView from "./ResultView";
import { useSpeech } from "../speech";
import type { DatasetProfile } from "../localdb";
import { askLocal } from "../localAgent";
import CorrectionPanel from "./CorrectionPanel";
import { AnswerText, EvidencePanel } from "./Evidence";
import { loadCorrections, loadSaved, loadSession, SavedAnalysis, saveSession, storeCorrections, storeSaved } from "../storage";

const SUGGESTED = [
  "What were the top 5 products by revenue?",
  "What was our revenue excluding cancelled invoices?",
  "Which products were returned most last quarter?",
  "Who are our best customers?",
  "Show monthly net revenue in 2011",
  "Which country generated the highest net revenue?",
  "What should I expect for revenue next month?",
  "What should we do about returns?",
];

interface Entry {
  question: string;
  response?: AskResponse;
  error?: string;
}

type StampKind = { text: string; color: string };

export function stampFor(e: Entry): StampKind | null {
  if (e.error) return { text: "Failed", color: "text-stamp" };
  const r = e.response;
  if (!r) return null;
  if (r.status === "clarification") return { text: "Needs detail", color: "text-gold-deep" };
  if (r.status === "refused" || r.status === "blocked") return { text: "Refused", color: "text-stamp" };
  if (r.status === "unavailable") return { text: "Can't answer", color: "text-stamp" };
  if (r.status !== "success") return { text: "Failed", color: "text-stamp" };
  if (r.attempts > 1) return { text: "Fixed & re-run", color: "text-gold-deep" };
  if (r.kind === "forecast") return { text: "Forecast", color: "text-gold-deep" };
  if (r.kind === "actions") return { text: "Action list", color: "text-ledger" };
  if (r.source === "learned" || r.applied_corrections?.length) return { text: "Learned from you", color: "text-ledger" };
  if (r.source === "offline") return { text: "Answered (backup)", color: "text-ledger" };
  if (r.source === "saved") return { text: "Saved answer", color: "text-ledger" };
  return { text: "Answered", color: "text-ledger" };
}

// Suggestions that fit the user's own file: sales questions for sales data, column-based ones otherwise.
function suggestionsFor(p: DatasetProfile): string[] {
  if (p.kind === "retail") {
    const year = p.date_range[1] ? String(p.date_range[1]).slice(0, 4) : "this year";
    return [
      "What were the top 5 products by revenue?",
      `Show monthly net revenue in ${year}`,
      "Which products were returned most?",
      "Who are our best customers?",
      "What were the top 5 products by revenue in the best sales month of this year?",
    ];
  }
  const num = p.columns.filter((c) => /^(DOUBLE|FLOAT|DECIMAL|HUGEINT|BIGINT|INTEGER|SMALLINT)/.test(c.type)).map((c) => c.name);
  const text = p.columns.filter((c) => /^VARCHAR/.test(c.type)).map((c) => c.name);
  const date = p.columns.find((c) => /^(DATE|TIMESTAMP)/.test(c.type))?.name;
  const words = (n: string) => n.replace(/_/g, " ");
  const out = ["How many rows are there, and what does each column contain?"];
  if (num[0] && text[0]) out.push(`What is the average ${words(num[0])} for each ${words(text[0])}?`);
  if (num[0] && text[0]) out.push(`Which ${words(text[0])} has the highest total ${words(num[0])}?`);
  if (num[0] && date) out.push(`Show total ${words(num[0])} by month`);
  if (text[1] ?? text[0]) out.push(`What are the 5 most common values of ${words(text[1] ?? text[0])}?`);
  return out;
}

export default function Workspace({ email, dataset }: { email: string; dataset: DatasetProfile | null }) {
  const [restored] = useState(() => loadSession(email));
  const [entries, setEntries] = useState<Entry[]>(() => restored?.entries ?? []);
  const [selected, setSelected] = useState<number | null>(() => (restored?.entries.length ? restored.entries.length - 1 : null));
  const [saved, setSaved] = useState<SavedAnalysis[]>(() => loadSaved(email));
  const [viewSaved, setViewSaved] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [injectFault, setInjectFault] = useState(false);
  const [simulateOutage, setSimulateOutage] = useState(false);
  const [conversationId, setConversationId] = useState(() => restored?.conversationId ?? crypto.randomUUID());
  const [corrections, setCorrections] = useState<Correction[]>(() => loadCorrections(email));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Spoken words land in the box for the user to check and send; nothing is sent automatically.
  const voice = useSpeech(setInput);

  useEffect(() => {
    const update = () => setCorrections(loadCorrections(email));
    window.addEventListener("datadukaan:corrections", update);
    return () => window.removeEventListener("datadukaan:corrections", update);
  }, [email]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [selected]);

  // Keep this session's questions and answers across page reloads (this browser only).
  useEffect(() => {
    saveSession(email, conversationId, entries);
  }, [email, conversationId, entries]);

  function toggleSave(entry: Entry) {
    if (!entry.response) return;
    const existing = saved.find((s) => s.response.id === entry.response!.id);
    const next = existing
      ? saved.filter((s) => s !== existing)
      : [
          // A follow-up like "Q3 2011 (...)" means little on its own, so label it with the answer's title.
          { id: entry.response.id, savedAt: new Date().toISOString(), question: entry.response.title || entry.question, response: entry.response },
          ...saved,
        ];
    setSaved(next);
    storeSaved(email, next);
    if (existing && viewSaved === existing.id) setViewSaved(null);
  }

  const history = (upTo = entries.length): Turn[] =>
    entries.slice(0, upTo).flatMap((e) => [
      { role: "user" as const, content: e.question },
      ...(e.response ? [{ role: "assistant" as const, content: e.response.answer, sql: e.response.sql }] : []),
    ]);

  async function submit(q: string) {
    const question = q.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    const idx = entries.length;
    setEntries((prev) => [...prev, { question }]);
    setSelected(idx);
    setViewSaved(null);
    try {
      const mode = simulateOutage ? "offline" : "auto";
      // A user's own file runs in the browser; remembered corrections apply to the built-in data only.
      const response = dataset
        ? await askLocal(question, history(), dataset, injectFault, mode)
        : await api.ask(question, history(), conversationId, injectFault, mode, corrections.filter((c) => c.enabled));
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, response } : e)));
      const used = new Set((response.applied_corrections ?? []).map((c) => c.id));
      if (used.size) storeCorrections(email, loadCorrections(email).map((c) => (used.has(c.id) ? { ...c, uses: (c.uses ?? 0) + 1 } : c)));
    } catch (err) {
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, error: String(err) } : e)));
    } finally {
      setBusy(false);
    }
  }

  // A kept correction: remember it, and show the corrected answer as the next stub.
  function remember(question: string, c: Correction, result: AskResponse) {
    storeCorrections(email, [c, ...loadCorrections(email)]);
    setEntries((prev) => [...prev, { question: `${question} (corrected)`, response: result }]);
    setSelected(entries.length);
    setViewSaved(null);
  }

  function startOver() {
    setEntries([]);
    setSelected(null);
    setViewSaved(null);
    setConversationId(crypto.randomUUID());
  }

  const savedView = viewSaved ? saved.find((s) => s.id === viewSaved) : undefined;
  const current: Entry | null = savedView ? { question: savedView.question, response: savedView.response } : selected !== null ? entries[selected] : null;
  const isSaved = (e: Entry | null) => !!e?.response && saved.some((s) => s.response.id === e.response!.id);

  return (
    <div className="space-y-4">
      <div className="sheet grid min-h-[520px] md:grid-cols-[230px_10px_1fr]">
        {/* Counterfoils: one stub per question, in the order asked. */}
        <aside className="border-b border-rule bg-[#FCFBF7] md:border-b-0">
          <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
            <span className="text-sm font-semibold">This session</span>
            {entries.length > 0 && (
              <button onClick={startOver} className="text-[13px] text-muted underline-offset-2 hover:text-carbon-deep hover:underline">
                Start over
              </button>
            )}
          </div>
          {entries.length === 0 ? (
            <p className="px-4 pb-4 text-[13px] leading-relaxed text-muted">
              Each question you ask is kept here as a stub, so you can go back to it. They stay after a reload, in this browser only.
            </p>
          ) : (
            <ol className="flex gap-0 overflow-x-auto md:block md:max-h-[640px] md:overflow-y-auto">
              {entries.map((e, i) => {
                const s = stampFor(e);
                return (
                  <li key={i} className="min-w-[200px] md:min-w-0">
                    <button
                      onClick={() => {
                        setSelected(i);
                        setViewSaved(null);
                      }}
                      className={`block w-full border-l-[3px] px-4 py-3 text-left transition-colors ${
                        !viewSaved && selected === i ? "border-carbon bg-carbon-wash/50" : "border-transparent hover:bg-carbon-wash/40"
                      }`}
                    >
                      <span className="narrow text-[15px] font-bold text-muted">No. {String(i + 1).padStart(3, "0")}</span>
                      <span className="mt-0.5 line-clamp-2 block text-[13.5px] leading-snug">{e.question}</span>
                      <span className={`mt-1 block text-xs ${s ? s.color : "text-muted"}`}>{s ? s.text : "Working on it…"}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {saved.length > 0 && (
            <div className="border-t border-rule">
              <p className="px-4 pb-1 pt-4 text-sm font-semibold">Saved analyses</p>
              <ul className="flex overflow-x-auto md:block md:max-h-[320px] md:overflow-y-auto">
                {saved.map((s) => (
                  <li key={s.id} className="min-w-[200px] md:min-w-0">
                    <button
                      onClick={() => setViewSaved(s.id)}
                      className={`block w-full border-l-[3px] px-4 py-2.5 text-left transition-colors ${
                        viewSaved === s.id ? "border-ledger bg-carbon-wash/50" : "border-transparent hover:bg-carbon-wash/40"
                      }`}
                    >
                      <span className="line-clamp-2 block text-[13.5px] leading-snug">{s.question}</span>
                      <span className="mt-0.5 block text-xs text-muted">Saved {new Date(s.savedAt).toLocaleDateString("en-GB")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <div className="perforation hidden bg-sheet md:block" aria-hidden />
        <div className="perforation-h h-2.5 md:hidden" aria-hidden />

        {/* The bill: the current answer. */}
        <section className="min-w-0 px-5 py-6 sm:px-8">
          {!current && <EmptyBill onAsk={submit} dataset={dataset} />}
          {current && (
            <Bill
              entry={current}
              onOption={submit}
              busy={busy}
              isLatest={!savedView && selected === entries.length - 1}
              saved={isSaved(current)}
              onToggleSave={() => toggleSave(current)}
              correction={
                // Corrections are worked out on the built-in data, so they aren't offered for answers about a user's own file.
                current.response && !savedView && selected !== null && !dataset ? (
                  <CorrectionPanel
                    key={current.response.id}
                    question={current.question.replace(/ \(corrected\)$/, "")}
                    response={current.response}
                    history={history(selected)}
                    offline={simulateOutage}
                    onRemember={(c, result) => remember(current.question.replace(/ \(corrected\)$/, ""), c, result)}
                  />
                ) : null
              }
            />
          )}
        </section>
      </div>

      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          submit(input);
        }}
        className="sheet z-10 md:sticky md:bottom-3"
      >
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <div className="flex items-end gap-3 px-4 pt-3">
          <textarea
            id="question"
            ref={inputRef}
            value={input}
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder={entries.length ? "Ask a follow-up, like “now only for Germany”" : "Ask about revenue, returns, customers or countries"}
            className="max-h-40 min-h-[44px] flex-1 resize-none border-b-2 border-ink bg-transparent px-1 py-2 text-[17px] outline-none placeholder:text-muted/70 focus:border-carbon"
          />
          {voice.supported && (
            <button
              type="button"
              onClick={voice.listening ? voice.stop : voice.start}
              disabled={busy}
              aria-pressed={voice.listening}
              aria-label={voice.listening ? "Stop listening" : "Speak your question"}
              title={voice.listening ? "Stop listening" : "Speak your question"}
              className={`mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 transition-colors disabled:opacity-40 ${
                voice.listening ? "animate-pulse border-stamp bg-stamp text-white" : "border-carbon-deep text-carbon-deep hover:bg-carbon-wash/60"
              }`}
            >
              {voice.listening ? <Square size={14} fill="currentColor" /> : <Mic size={18} />}
            </button>
          )}
          <button disabled={busy || !input.trim()} className="btn-carbon mb-1 flex items-center gap-2">
            {busy && <Loader2 className="animate-spin" size={15} />}
            {busy ? "Working" : "Ask"}
          </button>
        </div>
        {(voice.listening || voice.error) && (
          <p role="status" className={`px-4 pt-2 text-[13px] ${voice.error ? "text-stamp" : "text-carbon-deep"}`}>
            {voice.error ?? "Listening… speak your question, then check it and press Ask."}
          </p>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 pb-3 pt-2 text-[13px] text-muted">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={injectFault} onChange={(e) => setInjectFault(e.target.checked)} className="accent-carbon-deep" />
            Demo: make the first attempt fail, to watch it recover
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={simulateOutage} onChange={(e) => setSimulateOutage(e.target.checked)} className="accent-carbon-deep" />
            Demo: answer without the AI service (backup mode)
          </label>
        </div>
      </form>
    </div>
  );
}

function EmptyBill({ onAsk, dataset }: { onAsk: (q: string) => void; dataset: DatasetProfile | null }) {
  const list = dataset ? suggestionsFor(dataset) : SUGGESTED;
  return (
    <div className="max-w-2xl">
      <h1 className="wide text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.02] tracking-tight">
        {dataset ? `What do you want to know about ${dataset.source}?` : "What do you want to know about the shop's sales?"}
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
        {dataset
          ? `${dataset.row_count.toLocaleString("en-GB")} rows from your file, read in this browser. ${
              dataset.kind === "retail"
                ? "Returns and cancellations are kept apart from sales, the same way as the built-in data."
                : "Each answer says how it read the columns it used."
            }`
          : "Two years of sales from a UK online gift shop. Cancelled orders, returns and customers without an ID are counted the same way every time, and every answer shows what was counted."}
      </p>
      <div className="margin-rule mt-8">
        <p className="mb-1 text-sm font-semibold">Start with one of these</p>
        {list.map((s) => (
          <button key={s} onClick={() => onAsk(s)} className="ruled-line text-[15px]">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bill({
  entry,
  onOption,
  busy,
  isLatest,
  saved,
  onToggleSave,
  correction,
}: {
  entry: Entry;
  onOption: (q: string) => void;
  busy: boolean;
  isLatest: boolean;
  saved: boolean;
  onToggleSave: () => void;
  correction: React.ReactNode;
}) {
  const r = entry.response;
  const s = stampFor(entry);
  return (
    <article>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-[15px] italic text-muted">“{entry.question}”</p>
        {s && (
          <span key={entry.question + s.text} className={`stamp stamp-in shrink-0 ${s.color}`}>
            {s.text}
          </span>
        )}
      </div>

      {!r && !entry.error && (
        <div className="mt-6 flex items-center gap-3 text-[15px] text-muted">
          <Loader2 className="animate-spin text-carbon-deep" size={18} /> Working out the answer…
        </div>
      )}

      {entry.error && <p className="mt-5 text-[15px] text-stamp">Couldn't get an answer: {entry.error}. Check your connection and ask again.</p>}

      {r && (
        <>
          <p className={`mt-4 max-w-3xl leading-snug ${r.status === "success" && r.answer.length < 160 ? "text-[24px] font-medium" : "text-[18px]"}`}>
            <AnswerText text={r.answer} check={r.claims} />
          </p>
          {r.status === "success" && <EvidencePanel check={r.claims} draft={r.draft_answer} draftCheck={r.draft_claims} />}
          {!!r.applied_corrections?.length && (
            <p className="mt-3 max-w-3xl text-[13.5px] leading-snug text-ledger">
              Using what you taught me: {r.applied_corrections.map((c) => c.rule).join(" ")}{" "}
              <a href="#/learned" className="font-medium underline underline-offset-2">
                See what I've learned
              </a>
            </p>
          )}

          {r.status === "clarification" && !!r.options?.length && (
            <div className="margin-rule mt-6 max-w-xl">
              <p className="mb-1 text-sm font-semibold">Pick what you meant</p>
              {r.options.map((o) => (
                <button key={o} disabled={busy || !isLatest} onClick={() => onOption(o)} className="ruled-line text-[15px] disabled:opacity-50">
                  {o}
                </button>
              ))}
            </div>
          )}


          {r.status === "success" && (
            <>
              <button onClick={onToggleSave} className="mt-4 text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
                {saved ? "Remove from saved analyses" : "Save this analysis"}
              </button>
              <ResultView r={r} />
              {r.sql && !r.kind && correction}
            </>
          )}
        </>
      )}
    </article>
  );
}
