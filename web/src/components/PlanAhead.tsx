import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ActionPlan, api, ForecastMetric, ForecastResult, ForecastScope } from "../api";
import { ActionList, DiagnosisTable, RulesList } from "./Actions";
import { fmtValue, ForecastChart, ForecastDetails, monthLabel } from "./Forecast";

const METRICS: { key: ForecastMetric; label: string }[] = [
  { key: "net_revenue", label: "Net revenue" },
  { key: "units_sold", label: "Units sold" },
  { key: "orders", label: "Orders" },
  { key: "returned_units", label: "Units returned" },
  { key: "return_value", label: "Value of returns" },
];
const HORIZONS = [
  { months: 1, label: "Next month" },
  { months: 3, label: "Next 3 months" },
  { months: 6, label: "Next 6 months" },
];

type Entities = { countries: string[]; products: { code: string; description: string }[] };

export default function PlanAhead() {
  const [metric, setMetric] = useState<ForecastMetric>("net_revenue");
  const [scope, setScope] = useState<ForecastScope>("total");
  const [key, setKey] = useState<string>("");
  const [horizon, setHorizon] = useState(3);
  const [entities, setEntities] = useState<Entities | null>(null);
  const [f, setF] = useState<ForecastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    api.forecastEntities().then(setEntities).catch(() => setEntities({ countries: [], products: [] }));
    api.actions().then(setPlan).catch((e) => setPlanError(String(e)));
  }, []);

  useEffect(() => {
    if (scope !== "total" && !key) return;
    setBusy(true);
    setError(null);
    api
      .forecast(metric, scope, scope === "total" ? null : key, horizon)
      .then(setF)
      .catch((e) => setError(e.message ?? String(e)))
      .finally(() => setBusy(false));
  }, [metric, scope, key, horizon]);

  function pickScope(s: ForecastScope) {
    setScope(s);
    if (s === "country") setKey(entities?.countries[0] ?? "United Kingdom");
    if (s === "product") setKey(entities?.products[0]?.code ?? "85123A");
  }

  const first = f?.forecast[0];
  return (
    <div className="space-y-6">
      <section className="sheet px-5 py-7 sm:px-8">
        <h1 className="wide max-w-3xl text-[clamp(26px,3.6vw,38px)] font-extrabold leading-[1.05] tracking-tight">What to expect, and what to do about it</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Forecasts for the months after the data ends (9 December 2011), with a range showing how sure they are. Each forecast picks the
          model that would have been most accurate on the past year, and says how far off it typically was.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Picker label="What to forecast" value={metric} onChange={(v) => setMetric(v as ForecastMetric)} options={METRICS.map((m) => [m.key, m.label])} />
          <Picker
            label="For"
            value={scope}
            onChange={(v) => pickScope(v as ForecastScope)}
            options={[["total", "The whole shop"], ["country", "One country"], ["product", "One product"]]}
          />
          {scope !== "total" && (
            <Picker
              label={scope === "country" ? "Country" : "Product"}
              value={key}
              onChange={setKey}
              options={scope === "country" ? (entities?.countries ?? []).map((c) => [c, c]) : (entities?.products ?? []).map((p) => [p.code, `${p.description} (${p.code})`])}
            />
          )}
          <Picker label="How far ahead" value={String(horizon)} onChange={(v) => setHorizon(Number(v))} options={HORIZONS.map((h) => [String(h.months), h.label])} />
        </div>

        <div className="mt-6 min-h-[300px]">
          {busy && !f && (
            <p className="flex items-center gap-2 text-[15px] text-muted">
              <Loader2 size={16} className="animate-spin" /> Working out the forecast…
            </p>
          )}
          {error && <p className="text-[15px] text-stamp">{error}</p>}
          {f && first && !error && (
            <div className={busy ? "opacity-60 transition-opacity" : ""}>
              <p className="max-w-3xl text-[22px] font-medium leading-snug">
                {f.metric_label} for {f.label}: about <span className="narrow font-bold">{fmtValue(f.unit, first.value)}</span> in{" "}
                {monthLabel(first.period)}, most likely between {fmtValue(f.unit, first.lo80)} and {fmtValue(f.unit, first.hi80)}.
              </p>
              <p className="mt-1 text-[13.5px] text-muted">
                In back-tests this model was typically {Math.round(f.backtest.mape * 100)}% off
                {f.backtest.mape > 0.4 ? ", so treat this one as a rough guide." : "."}
              </p>
              <div className="mt-5">
                <ForecastChart f={f} />
              </div>
              <ForecastDetails f={f} />
            </div>
          )}
        </div>
      </section>

      <section className="sheet px-5 py-7 sm:px-8">
        <h2 className="wide text-[clamp(22px,3vw,30px)] font-extrabold leading-tight tracking-tight">Recommended actions</h2>
        {planError && <p className="mt-3 text-[15px] text-stamp">Couldn't build the action list: {planError}</p>}
        {!plan && !planError && (
          <p className="mt-3 flex items-center gap-2 text-[15px] text-muted">
            <Loader2 size={16} className="animate-spin" /> Checking products and countries…
          </p>
        )}
        {plan && (
          <>
            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-muted">
              The top products and countries were checked against the shop's own benchmarks for {plan.benchmarks.period} ({pct(plan.benchmarks.product_return_rate)} of
              product units sold came back) and against their forecasts for {plan.period}. Actions are ranked by how serious the finding is and how much money is
              at stake. Every action lists the figures it is based on.
            </p>
            <dl className="mt-5 flex flex-wrap gap-x-12 gap-y-4 border-y-[3px] border-double border-ink py-4">
              <Count value={plan.counts.Critical} label="critical" color="text-stamp" />
              <Count value={plan.counts.Watch} label="to watch" color="text-gold-deep" />
              <Count value={plan.counts.Healthy} label="healthy" color="text-ledger" />
              <Count value={plan.total_actions} label="actions found" />
            </dl>
            <div className="mt-4">
              <ActionList plan={plan} />
            </div>
            <h3 className="mb-3 mt-8 text-[17px] font-semibold">Everything that was checked</h3>
            <DiagnosisTable plan={plan} />
            <h3 className="mb-3 mt-8 text-[17px] font-semibold">The rules behind the actions</h3>
            <RulesList plan={plan} />
          </>
        )}
      </section>
    </div>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function Count({ value, label, color = "" }: { value: number; label: string; color?: string }) {
  return (
    <div>
      <dd className={`narrow text-[44px] font-extrabold leading-none ${color}`}>{value}</dd>
      <dt className="mt-1 text-[13px] text-muted">{label}</dt>
    </div>
  );
}

function Picker({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: string[][] }) {
  return (
    <label className="block min-w-0">
      <span className="block text-sm font-semibold">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full truncate border-b-2 border-ink bg-transparent py-1.5 text-[15px] outline-none focus:border-carbon"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
