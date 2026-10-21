import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bug, HelpCircle, Loader2, RotateCcw, ShieldAlert, Sparkles } from "lucide-react";
import { api, AskResponse, Turn } from "../api";
import ResultView from "./ResultView";

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

export default function Workspace() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [injectFault, setInjectFault] = useState(false);
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [entries]);

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
    try {
      const response = await api.ask(question, history(), conversationId, injectFault);
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, response } : e)));
    } catch (err) {
      setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, error: String(err) } : e)));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setEntries([]);
    setConversationId(crypto.randomUUID());
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <section className="min-w-0 space-y-4">
        {entries.length === 0 && (
          <div className="card p-6">
            <h1 className="text-xl font-semibold">Ask a question about two years of sales</h1>
            <p className="mt-1 text-sm text-slate-500">
              RetailIQ writes SQL, runs it on a read-only copy of the data and shows exactly what it did. Cancellations,
              returns and unknown customers are handled by documented rules.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTED.map((s) => (
                <button key={s} onClick={() => submit(s)} className="rounded-full border border-slate-200 px-3 py-1.5 text-sm hover:border-brand-500 hover:text-brand-700">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((e, i) => (
          <div key={i} className="space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-sm text-white">{e.question}</div>
            </div>
            {!e.response && !e.error && (
              <div className="card flex items-center gap-2 p-4 text-sm text-slate-500">
                <Loader2 className="animate-spin" size={16} /> Planning, writing SQL and running it…
              </div>
            )}
            {e.error && <div className="card border-rose-200 p-4 text-sm text-rose-700">Request failed: {e.error}</div>}
            {e.response && <ResponseCard r={e.response} onOption={(o) => submit(o)} disabled={busy || i !== entries.length - 1} />}
          </div>
        ))}
        <div ref={bottomRef} />

        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            submit(input);
          }}
          className="card sticky bottom-4 flex items-end gap-2 p-2"
        >
          <textarea
            value={input}
            onChange={(ev) => setInput(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder={entries.length ? "Ask a follow-up, e.g. “now only for Germany”" : "Ask about revenue, returns, customers, countries…"}
            className="max-h-40 min-h-[40px] flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
          />
          <button disabled={busy || !input.trim()} className="grid h-10 w-10 place-items-center rounded-lg bg-brand-600 text-white disabled:opacity-40" aria-label="Ask">
            {busy ? <Loader2 className="animate-spin" size={18} /> : <ArrowUp size={18} />}
          </button>
        </form>
      </section>

      <aside className="space-y-4">
        <div className="card p-4 text-sm">
          <div className="font-semibold">Session</div>
          <p className="mt-1 text-xs text-slate-500">Follow-ups use the last few turns as context.</p>
          <button onClick={reset} className="mt-3 flex items-center gap-1.5 text-xs font-medium text-brand-700">
            <RotateCcw size={14} /> New conversation
          </button>
          <label className="mt-4 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={injectFault} onChange={(e) => setInjectFault(e.target.checked)} className="mt-0.5" />
            <span>
              <span className="flex items-center gap-1 font-medium"><Bug size={12} /> Demo: inject an SQL fault</span>
              <span className="text-slate-500">Corrupts a column name in the first SQL so you can watch the agent inspect the error and retry.</span>
            </span>
          </label>
        </div>
        {entries.length > 0 && (
          <div className="card p-4 text-sm">
            <div className="font-semibold">Try next</div>
            <div className="mt-2 flex flex-col gap-1.5">
              {SUGGESTED.map((s) => (
                <button key={s} onClick={() => submit(s)} disabled={busy} className="text-left text-xs text-slate-600 hover:text-brand-700">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

function ResponseCard({ r, onOption, disabled }: { r: AskResponse; onOption: (o: string) => void; disabled: boolean }) {
  if (r.status === "clarification") {
    return (
      <div className="card border-amber-200 bg-amber-50/50 p-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
          <HelpCircle size={14} /> Clarification needed
        </div>
        <p className="mt-1 text-sm">{r.answer}</p>
        {!!r.options?.length && (
          <div className="mt-3 flex flex-wrap gap-2">
            {r.options.map((o) => (
              <button key={o} disabled={disabled} onClick={() => onOption(o)} className="rounded-full border border-amber-300 bg-white px-3 py-1 text-sm hover:bg-amber-100 disabled:opacity-50">
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (r.status === "refused" || r.status === "blocked") {
    return (
      <div className="card border-rose-200 bg-rose-50/50 p-4">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-700">
          <ShieldAlert size={14} /> {r.status === "blocked" ? "Blocked by SQL validator" : "Request refused"}
        </div>
        <p className="mt-1 text-sm">{r.answer}</p>
        {r.sql && <pre className="mt-2 overflow-x-auto rounded bg-white p-2 font-mono text-xs">{r.sql}</pre>}
      </div>
    );
  }
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-700">
        <Sparkles size={14} /> {r.title || "Answer"}
      </div>
      <p className="mt-1 text-sm leading-relaxed">{r.answer}</p>
      <ResultView r={r} />
    </div>
  );
}
