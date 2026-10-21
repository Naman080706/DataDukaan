import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, EngineScore } from "../api";

const SEGMENTS = [
  { key: "answered", name: "Correct answer", color: "#2F7A55" },
  { key: "asked_back", name: "Rightly asked back", color: "#4338A8" },
  { key: "refused", name: "Rightly refused", color: "#68657F" },
  { key: "failed", name: "Failed", color: "#B8322A" },
] as const;

const NOTES: Record<string, string> = {
  llm: "Gemini models only, no backup.",
  groq: "Gemini switched off, Groq models only.",
  offline: "No AI at all. Built with these questions in view.",
  chain: "What the app really does: Gemini, then Groq, then offline.",
};

export default function EngineComparison() {
  const [scores, setScores] = useState<EngineScore[] | null>(null);
  useEffect(() => {
    api.compare().then(setScores).catch(() => setScores([]));
  }, []);
  if (!scores?.length) return null;

  const data = scores.map((s) => ({ ...s, score: `${s.passed}/${s.total}` }));
  const total = Math.max(...scores.map((s) => s.total));

  return (
    <section className="sheet px-5 py-7 sm:px-8">
      <h2 className="wide text-[clamp(22px,2.8vw,30px)] font-extrabold leading-tight tracking-tight">Which engine gets the trap questions right</h2>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
        The same {total} questions, scored against our hand-written SQL. A pass can be a correct answer, asking back on a vague question, or
        refusing to delete data.
      </p>

      <figure className="mt-6">
        <ResponsiveContainer width="100%" height={scores.length * 62 + 70}>
          <BarChart data={data} layout="vertical" margin={{ left: 4, right: 56, top: 4 }} barSize={26}>
            <CartesianGrid stroke="#D6DBEC" horizontal={false} />
            <XAxis type="number" domain={[0, total]} ticks={[0, 5, 10, total]} tick={{ fontSize: 12, fill: "#68657F", fontFamily: "Archivo" }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 14, fill: "#1E1B33", fontFamily: "Archivo", fontWeight: 600 }} tickLine={false} axisLine={{ stroke: "#1E1B33" }} />
            <Tooltip
              cursor={{ fill: "#ECEAF8" }}
              contentStyle={{ borderRadius: 2, borderColor: "#D6DBEC", fontFamily: "Archivo", fontSize: 13 }}
              formatter={(v: number, name: string) => [`${v} of ${total}`, name]}
            />
            <Legend iconType="square" wrapperStyle={{ fontFamily: "Archivo", fontSize: 13, paddingTop: 8 }} />
            {SEGMENTS.map((seg, i) => (
              <Bar key={seg.key} dataKey={seg.key} name={seg.name} stackId="s" fill={seg.color}>
                {i === SEGMENTS.length - 1 && (
                  <LabelList dataKey="score" position="right" style={{ fontFamily: "Archivo", fontStretch: "72%", fontWeight: 800, fontSize: 18, fill: "#1E1B33" }} />
                )}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </figure>

      <dl className="mt-4 grid gap-x-8 gap-y-3 border-t border-rule pt-4 text-[13.5px] md:grid-cols-2">
        {scores.map((s) => (
          <div key={s.mode}>
            <dt className="font-semibold">
              {s.label} <span className="narrow font-bold text-muted">{s.passed}/{s.total}</span>
            </dt>
            <dd className="text-muted">
              {NOTES[s.mode]} Run on {new Date(s.run_at).toLocaleDateString("en-GB")}.
              {s.failures.map((f) => (
                <span key={f.id} className="block text-stamp">
                  {f.id} failed: {f.reason}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
