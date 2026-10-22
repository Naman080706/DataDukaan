import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Action, ActionPlan, Diagnosis } from "../api";

const SEVERITY_COLOR: Record<string, string> = {
  Critical: "text-stamp",
  Watch: "text-gold-deep",
  Opportunity: "text-ledger",
  Healthy: "text-ledger",
};

const pct = (v?: number | null) => (v === undefined || v === null ? "–" : `${(v * 100).toFixed(1)}%`);
const gbp = (v: number) => "£" + Math.round(v).toLocaleString("en-GB");

export function ActionList({ plan, limit }: { plan: ActionPlan; limit?: number }) {
  const actions = plan.actions.slice(0, limit ?? plan.actions.length);
  return (
    <ol className="space-y-0">
      {actions.map((a) => (
        <ActionItem key={a.rank} a={a} />
      ))}
    </ol>
  );
}

function ActionItem({ a }: { a: Action }) {
  const [open, setOpen] = useState(a.rank <= 2);
  return (
    <li className="grid grid-cols-[36px_1fr] gap-3 border-b border-rule py-3.5">
      <span className="narrow pt-0.5 text-right text-[22px] font-extrabold leading-none text-muted">{a.rank}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <button onClick={() => setOpen(!open)} className="flex items-start gap-1 text-left text-[15.5px] font-semibold leading-snug" aria-expanded={open}>
            <ChevronRight size={15} className={`mt-1 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
            {a.title}
          </button>
          <span className={`stamp stamp-sm shrink-0 ${SEVERITY_COLOR[a.severity]}`}>{a.severity}</span>
        </div>
        <p className="ml-5 mt-1 max-w-3xl text-[14px] leading-relaxed">{a.detail}</p>
        {open && (
          <div className="ml-5 mt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence</p>
            <ul className="margin-rule mt-1 space-y-0.5 text-[13.5px] leading-snug text-muted">
              {a.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted">
              Rule {a.rule} · about {a.entity.label} · money at stake about {gbp(a.at_stake_gbp)} · priority score {a.priority}
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

export function DiagnosisTable({ plan }: { plan: ActionPlan }) {
  const [filter, setFilter] = useState<"Critical" | "Watch" | "Healthy" | "all">("all");
  const rows = plan.diagnoses.filter((d) => filter === "all" || d.status === filter);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2" role="tablist" aria-label="Filter by status">
        {(["all", "Critical", "Watch", "Healthy"] as const).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className="tab">
            {f === "all" ? `All (${plan.diagnoses.length})` : `${f} (${plan.counts[f]})`}
          </button>
        ))}
      </div>
      <div className="mt-3 max-h-[440px] overflow-auto">
        <table className="ledger w-full text-[13.5px]">
          <thead className="sticky top-0 bg-sheet">
            <tr>
              <th>Product or country</th>
              <th className="w-24">Status</th>
              <th className="hidden md:table-cell">Why</th>
              <th className="text-right">Returned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <DiagnosisRow key={d.kind + d.key} d={d} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiagnosisRow({ d }: { d: Diagnosis }) {
  return (
    <tr>
      <td>
        {d.label}
        <span className="block text-xs text-muted">
          {d.kind === "country" ? "Country" : "Product"} · {gbp(d.net_revenue_gbp)} net revenue, last 12 months
        </span>
      </td>
      <td className={`font-semibold ${SEVERITY_COLOR[d.status]}`}>{d.status}</td>
      <td className="hidden text-muted md:table-cell">{d.reasons.length ? d.reasons.join("; ") : "Within the shop's benchmarks"}</td>
      <td className="narrow text-right text-[15px]">{pct(d.kind === "product" ? d.return_rate : d.return_value_share)}</td>
    </tr>
  );
}

export function RulesList({ plan }: { plan: ActionPlan }) {
  return (
    <dl className="grid gap-x-8 gap-y-3 md:grid-cols-2">
      {plan.rules.map((r) => (
        <div key={r.id} className="margin-rule">
          <dt className="text-[14px] font-semibold">
            {r.id}. {r.name} <span className="font-normal text-muted">({r.applies_to}s)</span>
          </dt>
          <dd className="mt-0.5 text-[13.5px] leading-snug text-muted">{r.rule}</dd>
        </div>
      ))}
    </dl>
  );
}
