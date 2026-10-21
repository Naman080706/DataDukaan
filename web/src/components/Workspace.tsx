import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, AskResponse, Turn } from "../api";
import ResultView from "./ResultView";
import { loadSaved, loadSession, SavedAnalysis, saveSession, storeSaved } from "../storage";

const SUGGESTED = [
  "What were the top 5 products by revenue?",
  "What was our revenue excluding cancelled invoices?",
  "Which products were returned most last quarter?",
  "Who are our best customers?",
  "Show monthly net revenue in 2011",
  "Which country generated the highest net revenue?",
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
  if (r.status === "clarification") return { text: "Needs detail", color: "text-carbon" };
  if (r.status === "refused" || r.status === "blocked") return { text: "Refused", color: "text-stamp" };
  if (r.status === "unavailable") return { text: "Can't answer", color: "text-stamp" };
  if (r.status !== "success") return { text: "Failed", color: "text-stamp" };
  if (r.attempts > 1) return { text: "Fixed & re-run", color: "text-carbon" };
  if (r.source === "offline") return { text: "Answered offline", color: "text-ledger" };
  if (r.source === "saved") return { text: "Saved answer", color: "text-ledger" };
  return { text: "Answered", color: "text-ledger" };
}

export default function Workspace() {
  const [restored] = useState(loadSession);
  const [entries, setEntries] = useState<Entry[]>(() => restored?.entries ?? []);
  const [selected, setSelected] = useState<number | null>(() => (restored?.entries.length ? restored.entries.length - 1 : null));
  const [saved, setSaved] = useState<SavedAnalysis[]>(loadSaved);
  const [viewSaved, setViewSaved] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [injectFault, setInjectFault] = useState(false);
  const [simulateOutage, setSimulateOutage] = useState(false);
  const [conversationId, setConversationId] = useState(() => restored?.conversationId ?? crypto.randomUUID());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [selected]);

  // Keep this session's questions and answers across page reloads (this browser only).
  useEffect(() => {
    saveSession(conversationId, entries);
  }, [conversationId, entries]);

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
    storeSaved(next);
    if (existing && viewSaved === existing.id) setViewSaved(null);
  }

  const history = (): Turn[] =>
    entries.flatMap((e) => [
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
      const response = await api.ask(question, history(), conversationId, injectFault, simulateOutage ? "offline" : "auto");
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, response } : e)));
    } catch (err) {
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, error: String(err) } : e)));
    } finally {
      setBusy(false);
    }
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
        <aside className="border-b border-rule bg-[#FAFAFD] md:border-b-0">
          <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
            <span className="text-sm font-semibold">This session</span>
            {entries.length > 0 && (
              <button onClick={startOver} className="text-[13px] text-muted underline-offset-2 hover:text-carbon hover:underline">
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
                        !viewSaved && selected === i ? "border-carbon bg-carbon-wash/70" : "border-transparent hover:bg-carbon-wash/40"
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
                        viewSaved === s.id ? "border-ledger bg-carbon-wash/70" : "border-transparent hover:bg-carbon-wash/40"
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
          {!current && <EmptyBill onAsk={submit} />}
          {current && (
            <Bill
              entry={current}
              onOption={submit}
              busy={busy}
              isLatest={!savedView && selected === entries.length - 1}
              saved={isSaved(current)}
              onToggleSave={() => toggleSave(current)}
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
          <button disabled={busy || !input.trim()} className="btn-carbon mb-1 flex items-center gap-2">
            {busy && <Loader2 className="animate-spin" size={15} />}
            {busy ? "Working" : "Ask"}
          </button>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 pb-3 pt-2 text-[13px] text-muted">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={injectFault} onChange={(e) => setInjectFault(e.target.checked)} className="accent-carbon" />
            Demo: break the first SQL, to watch the agent fix it
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={simulateOutage} onChange={(e) => setSimulateOutage(e.target.checked)} className="accent-carbon" />
            Demo: pretend the AI is down, to use the offline engine
          </label>
        </div>
      </form>
    </div>
  );
}

function EmptyBill({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="max-w-2xl">
      <h1 className="wide text-[clamp(28px,4.2vw,44px)] font-extrabold leading-[1.02] tracking-tight">
        What do you want to know about the shop's sales?
      </h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
        Two years of invoices from a UK online gift shop. Cancelled orders, returns and customers without an ID are counted the same way every
        time, and every answer shows the SQL that produced it.
      </p>
      <div className="margin-rule mt-8">
        <p className="mb-1 text-sm font-semibold">Start with one of these</p>
        {SUGGESTED.map((s) => (
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
}: {
  entry: Entry;
  onOption: (q: string) => void;
  busy: boolean;
  isLatest: boolean;
  saved: boolean;
  onToggleSave: () => void;
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
          <Loader2 className="animate-spin text-carbon" size={18} /> Reading the question, writing SQL and running it on the ledger…
        </div>
      )}

      {entry.error && <p className="mt-5 text-[15px] text-stamp">The server didn't respond: {entry.error}. Check that the API is running, then ask again.</p>}

      {r && (
        <>
          <p className={`mt-4 max-w-3xl leading-snug ${r.status === "success" && r.answer.length < 160 ? "text-[24px] font-medium" : "text-[18px]"}`}>{r.answer}</p>

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

          {(r.status === "refused" || r.status === "blocked") && r.sql && <pre className="carbon-copy mt-5">{r.sql}</pre>}

          {r.status === "success" && (
            <>
              <button onClick={onToggleSave} className="mt-4 text-[13px] font-medium text-carbon underline-offset-2 hover:underline">
                {saved ? "Remove from saved analyses" : "Save this analysis"}
              </button>
              <ResultView r={r} />
            </>
          )}
        </>
      )}
    </article>
  );
}
