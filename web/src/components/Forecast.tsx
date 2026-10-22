import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ForecastResult } from "../api";
import { SqlInspector } from "./ResultView";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MODEL_NAMES: Record<string, string> = { seasonal: "Same month last year", trend: "Recent trend", average: "3-month average", blend: "Seasonal + trend blend" };

export const monthLabel = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(0, 4)}`;

export function fmtValue(unit: string, v: number, compact = false): string {
  if (compact) return (unit === "gbp" ? "£" : "") + Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  return unit === "gbp"
    ? "£" + v.toLocaleString("en-GB", { maximumFractionDigits: 0 })
    : v.toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

type Point = { label: string; actual?: number; forecast?: number; band80?: [number, number]; band95?: [number, number] };

export function ForecastChart({ f, months = 13 }: { f: ForecastResult; months?: number }) {
  const hist = f.history.slice(-months);
  const last = hist[hist.length - 1];
  const data: Point[] = [
    ...hist.map((h) => ({ label: monthLabel(h.period), actual: h.value })),
    ...f.forecast.map((p) => ({ label: monthLabel(p.period), forecast: p.value, band80: [p.lo80, p.hi80] as [number, number], band95: [p.lo95, p.hi95] as [number, number] })),
  ];
  // Start the forecast line (and its ranges) at the last real month so the two lines join.
  if (last) {
    const i = hist.length - 1;
    data[i] = { ...data[i], forecast: last.value, band80: [last.value, last.value], band95: [last.value, last.value] };
  }
  const axis = { fontSize: 12, fill: "#6B6F66", fontFamily: "Archivo" };
  const tip = (v: number | [number, number], name: string) =>
    Array.isArray(v) ? [`${fmtValue(f.unit, v[0])} to ${fmtValue(f.unit, v[1])}`, name] : [fmtValue(f.unit, v), name];
  return (
    <figure>
      <figcaption className="mb-2 text-[13px] text-muted">
        {f.metric_label} for {f.label}, by month: the last {hist.length} months and the forecast
      </figcaption>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={data} margin={{ left: 4, right: 16, top: 8 }}>
          <CartesianGrid stroke="#DED0AB" vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: "#1D2521" }} interval="preserveStartEnd" minTickGap={18} />
          <YAxis tick={axis} tickFormatter={(v: number) => fmtValue(f.unit, v, true)} tickLine={false} axisLine={false} width={60} />
          <Tooltip formatter={tip} contentStyle={{ borderRadius: 2, borderColor: "#DED0AB", fontFamily: "Archivo" }} />
          <Legend wrapperStyle={{ fontSize: 12, fontFamily: "Archivo" }} />
          <Area dataKey="band95" name="95% range" stroke="none" fill="#C8B273" fillOpacity={0.18} isAnimationActive={false} />
          <Area dataKey="band80" name="80% range" stroke="none" fill="#C8B273" fillOpacity={0.38} isAnimationActive={false} />
          <Line dataKey="actual" name="What happened" stroke="#009B77" strokeWidth={2.5} dot={{ r: 2.5, fill: "#009B77" }} isAnimationActive={false} />
          <Line dataKey="forecast" name="Forecast" stroke="#7D6A2E" strokeWidth={2.5} strokeDasharray="6 4" dot={{ r: 3, fill: "#7D6A2E" }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </figure>
  );
}

export function ForecastDetails({ f }: { f: ForecastResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <table className="ledger w-full max-w-2xl text-[14px]">
        <thead>
          <tr>
            <th>Month</th>
            <th className="text-right">Forecast</th>
            <th className="text-right">80% range</th>
            <th className="hidden text-right sm:table-cell">95% range</th>
          </tr>
        </thead>
        <tbody>
          {f.forecast.map((p) => (
            <tr key={p.period}>
              <td>{monthLabel(p.period)}</td>
              <td className="narrow text-right text-[15px] font-bold">{fmtValue(f.unit, p.value)}</td>
              <td className="narrow text-right text-[15px]">
                {fmtValue(f.unit, p.lo80)} to {fmtValue(f.unit, p.hi80)}
              </td>
              <td className="narrow hidden text-right text-[15px] text-muted sm:table-cell">
                {fmtValue(f.unit, p.lo95)} to {fmtValue(f.unit, p.hi95)}
              </td>
            </tr>
          ))}
          {f.forecast.length > 1 && (
            <tr>
              <td className="font-semibold">Total</td>
              <td className="narrow text-right text-[15px] font-bold">{fmtValue(f.unit, f.total.value)}</td>
              <td className="narrow text-right text-[15px]">
                {fmtValue(f.unit, f.total.lo80)} to {fmtValue(f.unit, f.total.hi80)}
              </td>
              <td className="hidden sm:table-cell" />
            </tr>
          )}
        </tbody>
      </table>
      <ul className="margin-rule mt-4 max-w-3xl space-y-1 text-[13.5px] leading-snug text-muted">
        {f.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <button onClick={() => setOpen(!open)} className="mt-3 text-[13px] font-medium text-carbon-deep underline-offset-2 hover:underline">
        {open ? "Hide how the forecast was tested" : "Show how the forecast was tested"}
      </button>
      {open && (
        <div className="mt-3 grid gap-6 lg:grid-cols-2">
          <div>
            <p className="mb-1.5 text-sm font-semibold">Models tried, by typical error in back-tests</p>
            <table className="ledger w-full text-[13.5px]">
              <tbody>
                {f.backtest.models.map((m) => (
                  <tr key={m.name}>
                    <td>
                      {MODEL_NAMES[m.name] ?? m.name}
                      {m.name === f.model.name && <span className="ml-2 text-xs font-semibold text-ledger">used</span>}
                      <span className="block text-xs text-muted">{m.description}</span>
                    </td>
                    <td className="narrow text-right text-[15px]">{Math.round(m.mape * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mb-1.5 mt-4 text-sm font-semibold">The monthly figures it was built from</p>
            <SqlInspector sql={f.sql} />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-semibold">Back-test: predicted one month ahead vs what happened</p>
            <table className="ledger w-full text-[13.5px]">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="text-right">Predicted</th>
                  <th className="text-right">Actual</th>
                </tr>
              </thead>
              <tbody>
                {f.backtest.points.map((p) => (
                  <tr key={p.period}>
                    <td>{monthLabel(p.period)}</td>
                    <td className="narrow text-right text-[15px]">{fmtValue(f.unit, p.predicted)}</td>
                    <td className="narrow text-right text-[15px]">{fmtValue(f.unit, p.actual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
