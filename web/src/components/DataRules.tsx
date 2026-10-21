import { useEffect, useState } from "react";
import { api } from "../api";

const RULES: { term: string; body: string }[] = [
  { term: "Cancelled invoices", body: "Invoice numbers starting with C are cancellations or credit notes. They never count as sales and are counted separately when you ask about them. “Revenue excluding cancelled invoices” means sale lines only." },
  { term: "Returns", body: "Returned items sit on C invoices with a negative quantity. Net revenue is sales minus these returns. “Returned most” ranks products by units; “returned most often” ranks them by the number of return invoices." },
  { term: "Customers without an ID", body: "About one line in five has no customer ID. Those lines stay in totals such as revenue by country, but are left out of customer rankings and customer counts, and the answer says so." },
  { term: "Things that aren't products", body: "Postage, manual adjustments, bank charges, Amazon fees, samples, discounts, test codes and gift vouchers are left out of product rankings and kept in transaction totals." },
  { term: "Stock write-offs and bad debt", body: "Negative quantities without a C invoice are damaged or lost stock at £0. Invoices starting with A are bad-debt adjustments. Neither is a sale or a return." },
  { term: "Money", body: "Line value is quantity times unit price, in pounds sterling, rounded to the penny." },
  { term: "Dates", body: "Years are calendar years. The data ends on 9 December 2011, so “last quarter” means July to September 2011, the last complete quarter, and the answer says so." },
  { term: "Vague questions", body: "If the answer depends on a measure you didn't name, such as “best customers” or “top products”, the agent asks which one you mean instead of picking for you." },
  { term: "Safety", body: "The agent can only read. Each query is parsed before it runs; anything that writes, runs more than one statement, opens files or reaches other tables is refused, and the database itself is opened read-only." },
];

export default function DataRules() {
  const [rules, setRules] = useState<{ data_rules: string; ambiguity_rules: string; non_product_codes: string[] } | null>(null);
  const [schema, setSchema] = useState<{ tables: { name: string; columns: { name: string; type: string }[] }[]; row_count: number } | null>(null);
  useEffect(() => {
    api.rules().then(setRules);
    api.schema().then(setSchema);
  }, []);

  return (
    <div className="space-y-6">
      <section className="sheet px-5 py-7 sm:px-8">
        <h1 className="wide max-w-3xl text-[clamp(26px,3.6vw,38px)] font-extrabold leading-[1.05] tracking-tight">How the shop's messy records are counted</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          The same rules go into the agent's instructions and into the hand-written SQL the tests are checked against, so both always use one definition.
        </p>
        <dl className="mt-8 border-t-[3px] border-double border-ink">
          {RULES.map((r) => (
            <div key={r.term} className="grid gap-1 border-b border-rule py-4 md:grid-cols-[260px_1fr] md:gap-8">
              <dt className="text-[16px] font-bold">{r.term}</dt>
              <dd className="max-w-2xl text-[15px] leading-relaxed text-ink/85">{r.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="sheet min-w-0 px-5 py-6 sm:px-8">
          <h2 className="text-lg font-bold">The exact instructions the agent gets</h2>
          <pre className="carbon-copy mt-3 max-h-[520px] whitespace-pre-wrap">{rules ? `${rules.data_rules}\n\n${rules.ambiguity_rules}` : "Loading…"}</pre>
        </section>
        <section className="sheet min-w-0 px-5 py-6 sm:px-8">
          <h2 className="text-lg font-bold">The transactions table</h2>
          {schema && <p className="mt-1 text-[13px] text-muted">{schema.row_count.toLocaleString("en-GB")} rows, one per invoice line</p>}
          <table className="ledger mt-3 w-full text-[13.5px]">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {schema?.tables[0].columns.map((c) => (
                <tr key={c.name}>
                  <td className="font-mono text-[12.5px]">{c.name}</td>
                  <td className="text-muted">{c.type.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rules && <p className="mt-3 text-[13px] leading-relaxed text-muted">Codes treated as non-products: {rules.non_product_codes.join(", ")}, and any code starting with gift_, TEST or ADJUST.</p>}
        </section>
      </div>
    </div>
  );
}
