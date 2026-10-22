import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, AskResponse, Correction, CorrectionOptions, CorrectionType, CorrectResponse, Turn } from "../api";
import { SortableTable } from "./ResultView";

const TYPES: { key: CorrectionType; label: string; hint: string }[] = [
  { key: "wrong_metric", label: "It counted the wrong thing", hint: "e.g. it used net revenue, but I meant revenue before returns" },
  { key: "wrong_period", label: "Wrong period or filter", hint: "e.g. “last year” should mean the last 12 months" },
  { key: "wrong_grouping", label: "Wrong breakdown", hint: "e.g. I wanted it month by month, not one total" },
  { key: "missing_exclusion", label: "It should have left something out", hint: "e.g. leave the UK out of country rankings" },
  { key: "other", label: "Something else", hint: "say in your own words what was wrong" },
];

let optionsCache: Promise<CorrectionOptions> | null = null;
const loadOptions = () => (optionsCache ??= api.correctionOptions());

export default function CorrectionPanel({
  question,
  response,
  history,
  offline,
  onRemember,
}: {
  question: string;
  response: AskResponse;
  history: Turn[];
  offline: boolean;
  onRemember: (c: Correction, result: AskResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CorrectionOptions | null>(null);
  const [type, setType] = useState<CorrectionType | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CorrectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open && !options) loadOptions().then(setOptions).catch((e) => setError(String(e)));
  }, [open, options]);

  const choices = type && type !== "other" ? options?.choices[type] ?? [] : [];
  const ready = !!type && (type === "other" ? rationale.trim().length > 3 : !!choice);

  async function preview_() {
    if (!type || !ready) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const out = await api.correct({
        question, original_sql: response.sql, type, choice: type === "other" ? null : choice, rationale, history,
        mode: offline ? "offline" : "auto",
      });
      if (out.status !== "success") setError(out.answer ?? "Couldn't work out the corrected answer.");
      else setPreview(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (saved)
    return <p className="mt-4 text-[13.5px] text-ledger">Remembered. Similar questions will use this from now on; see “What I've learned”.</p>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="mt-4 text-[13px] font-medium text-stamp underline-offset-2 hover:underline">
        That's not quite right
      </button>
    );

  return (
    <div className="mt-5 max-w-3xl border border-rule bg-[#FCFBF7] px-4 py-4">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-[15px] font-semibold">What was wrong with this answer?</p>
        <button onClick={() => setOpen(false)} className="text-[13px] text-muted hover:text-ink">
          Cancel
        </button>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted">
        DataDukaan works out the corrected answer for you to check. If you keep it, it remembers the correction and uses it for similar questions.
      </p>
      <fieldset className="mt-3 space-y-1.5">
        <legend className="sr-only">Kind of mistake</legend>
        {TYPES.map((t) => (
          <label key={t.key} className="flex cursor-pointer items-start gap-2 text-[14px]">
            <input
              type="radio"
              name="correction-type"
              checked={type === t.key}
              onChange={() => {
                setType(t.key);
                setChoice("");
                setPreview(null);
              }}
              className="mt-1 accent-carbon-deep"
            />
            <span>
              {t.label}
              <span className="block text-xs text-muted">{t.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choices.length > 0 && (
        <label className="mt-4 block">
          <span className="block text-sm font-semibold">What it should have done</span>
          <select
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value);
              setPreview(null);
            }}
            className="mt-1 w-full border-b-2 border-ink bg-transparent py-1.5 text-[15px] outline-none focus:border-carbon"
          >
            <option value="">Choose…</option>
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type && (
        <label className="mt-4 block">
          <span className="block text-sm font-semibold">In your own words {type !== "other" && <span className="font-normal text-muted">(optional)</span>}</span>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Why it matters, or what you meant"
            className="mt-1 w-full resize-none border-b-2 border-ink bg-transparent px-1 py-1.5 text-[15px] outline-none focus:border-carbon"
          />
        </label>
      )}
      <button onClick={preview_} disabled={!ready || busy} className="btn-carbon mt-4 flex items-center gap-2">
        {busy && <Loader2 size={15} className="animate-spin" />}
        Show the corrected answer
      </button>
      {error && <p className="mt-3 text-[14px] text-stamp">{error}</p>}

      {preview?.result && preview.correction && (
        <div className="mt-5 border-t border-rule pt-4">
          <p className="text-sm font-semibold">Corrected answer</p>
          <p className="mt-1 text-[17px] leading-snug">{preview.result.answer}</p>
          <div className="mt-3">
            <SortableTable columns={preview.result.columns} rows={preview.result.rows.slice(0, 12)} exportable={false} />
          </div>
          <p className="mt-3 text-[13.5px] leading-snug">
            <span className="font-semibold">What I'll remember: </span>
            {preview.correction.rule}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              onClick={() => {
                onRemember(preview.correction!, preview.result!);
                setSaved(true);
              }}
              className="btn-carbon"
            >
              Remember this
            </button>
            <button onClick={() => setPreview(null)} className="text-[13px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline">
              Still not right, change the correction
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
