import { useEffect, useState } from "react";
import { api } from "../api";

const RULES: { term: string; body: string }[] = [
  { term: "Cancelled orders", body: "Invoice numbers starting with C are cancellations. They never count as sales, and are counted separately when you ask about them. “Revenue excluding cancelled invoices” means sales only." },
  { term: "Returns", body: "Returned items are recorded on those C invoices. Net revenue is sales minus returns. “Returned most” ranks products by how many items came back; “returned most often” ranks them by how many separate returns there were." },
  { term: "Customers without an ID", body: "About one sale in five has no customer ID. Those sales still count towards totals such as revenue by country, but are left out of customer rankings and customer counts, and the answer says so." },
  { term: "Things that aren't products", body: "Postage, bank charges, Amazon fees, samples, discounts, gift vouchers and manual adjustments are left out of product rankings, but still count towards overall totals." },
  { term: "Stock write-offs and bad debt", body: "Items written off as damaged or lost, and invoices starting with A (bad-debt adjustments), are neither sales nor returns." },
  { term: "Money", body: "Each item's value is the number sold times its price, in pounds sterling, rounded to the penny." },
  { term: "Dates", body: "Years are calendar years. The data ends on 9 December 2011, part-way through a quarter, so “last quarter” could mean July to September (the last complete quarter) or October to 9 December. DataDukaan asks which one you mean; “last month” works the same way." },
  { term: "Vague questions", body: "If the answer depends on something you didn't say, such as whether “best customers” means most money spent or most orders, DataDukaan asks instead of picking for you." },
  { term: "Safety", body: "DataDukaan can only look at the sales records. Every calculation is checked before it runs, and anything that would change, delete or copy the records is refused." },
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
          DataDukaan follows these rules for every answer, and our answer key for the trap tests uses the same rules, so both always count things the same way.
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

      <details className="sheet group px-5 py-5 sm:px-8">
        <summary className="cursor-pointer text-[15px] font-semibold text-carbon-deep">For analysts: the exact rules and how the data is stored</summary>
      <div className="mt-5 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="min-w-0">
          <h2 className="text-lg font-bold">The exact instructions the AI gets</h2>
          <pre className="carbon-copy mt-3 max-h-[520px] whitespace-pre-wrap">{rules ? `${rules.data_rules}\n\n${rules.ambiguity_rules}` : "Loading…"}</pre>
        </section>
        <section className="min-w-0">
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
      </details>
    </div>
  );
}
