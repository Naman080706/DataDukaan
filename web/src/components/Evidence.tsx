import { Fragment, useState } from "react";
import { Claim, ClaimCheck } from "../api";

export const CATEGORY_LABEL: Record<string, string> = {
  wrong_metric: "Wrong metric definition",
  wrong_period: "Wrong filter or period",
  wrong_grouping: "Wrong grouping",
  missing_exclusion: "Missing exclusion rule",
  misread_result: "Correct SQL, misread result",
  unsupported_number: "Number not in the result",
  unsupported_causal: "Unsupported explanation",
};

const VERDICT: Record<string, { label: string; color: string }> = {
  supported: { label: "Backed by the result", color: "text-ledger" },
  hypothesis: { label: "Hypothesis", color: "text-gold-deep" },
  unsupported: { label: "Not in the result", color: "text-stamp" },
  contradicted: { label: "Contradicts the result", color: "text-stamp" },
};

const MARK: Record<string, string> = {
  hypothesis: "decoration-gold decoration-dotted underline decoration-2 underline-offset-4",
  unsupported: "decoration-stamp decoration-wavy underline underline-offset-4",
  contradicted: "decoration-stamp decoration-wavy underline underline-offset-4",
  supported: "decoration-carbon/60 decoration-dotted underline underline-offset-4",
};

/** The answer text with its claims marked: hypotheses and problems always, everything when `all` is set. */
export function AnswerText({ text, check, all = false }: { text: string; check?: ClaimCheck; all?: boolean }) {
  if (!check?.claims.length) return <>{text}</>;
  // Non-overlapping spans, widest claim first (an explanation clause can contain a number claim).
  const shown = check.claims
    .filter((c) => all || c.verdict !== "supported")
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce<Claim[]>((acc, c) => (acc.length && c.start < acc[acc.length - 1].end ? acc : [...acc, c]), []);
  const parts: JSX.Element[] = [];
  let at = 0;
  shown.forEach((c) => {
    if (c.start > at) parts.push(<Fragment key={`t${at}`}>{text.slice(at, c.start)}</Fragment>);
    parts.push(
      <span key={c.id} className={MARK[c.verdict]} title={`${VERDICT[c.verdict].label}: ${c.evidence}`}>
        {text.slice(c.start, c.end)}
        {c.verdict === "hypothesis" && <sup className="ml-0.5 text-[10px] font-semibold uppercase tracking-wide text-gold-deep">hypothesis</sup>}
      </span>,
    );
    at = c.end;
  });
  if (at < text.length) parts.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

export function EvidencePanel({ check, draft, draftCheck }: { check?: ClaimCheck; draft?: string; draftCheck?: ClaimCheck }) {
  const [open, setOpen] = useState(false);
  if (!check) return null;
  const { supported, hypothesis } = check.counts;
  const issues = check.counts.unsupported + check.counts.contradicted;
  const summary =
    `${supported} statement${supported === 1 ? "" : "s"} traced to the result` +
    (hypothesis ? `, ${hypothesis} marked as a hypothesis` : "") +
    (issues ? `, ${issues} not backed by it` : "");
  return (
    <div className="mt-3 max-w-3xl">
      {draft && draftCheck && (
        <p className="mb-2 text-[13.5px] leading-snug text-gold-deep">
          The first draft of this answer said things the result doesn't show ({draftCheck.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(", ").toLowerCase()}),
          so it was rewritten from the figures.
        </p>
      )}
      <button onClick={() => setOpen(!open)} className="text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
        {open ? "Hide the evidence check" : `Evidence check: ${summary}`}
      </button>
      {open && (
        <div className="margin-rule mt-2 space-y-3">
          <ClaimList claims={check.claims} />
          {draft && draftCheck && (
            <div>
              <p className="text-[13px] font-semibold">The rejected first draft</p>
              <p className="mt-1 text-[14px] italic leading-snug">
                “<AnswerText text={draft} check={draftCheck} />”
              </p>
              <div className="mt-2">
                <ClaimList claims={draftCheck.claims.filter((c) => c.verdict !== "supported")} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ClaimList({ claims }: { claims: Claim[] }) {
  if (!claims.length) return <p className="text-[13px] text-muted">No checkable statements.</p>;
  return (
    <ul className="space-y-1.5">
      {claims.map((c) => (
        <li key={c.id} className="grid grid-cols-[150px_1fr] gap-3 text-[13px] leading-snug">
          <span className={`font-semibold ${VERDICT[c.verdict].color}`}>{VERDICT[c.verdict].label}</span>
          <span>
            <span className="font-medium">“{c.text}”</span>
            <span className="block text-muted">
              {c.evidence}
              {c.category ? ` · ${CATEGORY_LABEL[c.category] ?? c.category}` : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
