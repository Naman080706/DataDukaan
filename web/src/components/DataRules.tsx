import { useEffect, useState } from "react";
import { api } from "../api";

const PLAIN_RULES: { title: string; body: string }[] = [
  { title: "Cancellations", body: "Invoice numbers starting with “C” are cancellations / credit notes. They are excluded from sales and counted separately. “Revenue excluding cancelled invoices” means sale lines only." },
  { title: "Returns", body: "Returned items appear on “C” invoices with negative quantity. They are never counted as sales. Net revenue = sales minus these returns. “Returned most” ranks by units; “returned most often” ranks by number of return invoices." },
  { title: "Missing customers", body: "About 20% of lines have no customer ID. They stay in totals (revenue, country revenue) but are excluded from customer rankings and customer counts, and the answer says so." },
  { title: "Non-product codes", body: "Postage (POST, DOT), manual adjustments (M), bank charges, Amazon fees, samples, discounts, test and gift-voucher codes are excluded from product rankings but kept in transaction totals." },
  { title: "Stock adjustments & bad debt", body: "Negative quantities without a “C” invoice (damaged / lost stock, price £0) and “A” bad-debt adjustment invoices are neither sales nor returns." },
  { title: "Money & dates", body: "Line value = quantity × unit price, in GBP (£). Years are calendar years. “Last quarter” means the last complete quarter in the data (Q3 2011: Jul–Sep), not today's date, because the data ends on 9 Dec 2011." },
  { title: "Ambiguity", body: "If a question depends on an undefined metric (e.g. “best customers”, “top products”, “how are we doing”), the agent asks which metric to use instead of guessing." },
  { title: "Safety", body: "The agent only runs one SELECT at a time on a read-only DuckDB connection. SQL is parsed with sqlglot; writes, multiple statements, file/network functions and other tables are blocked." },
];

export default function DataRules() {
  const [rules, setRules] = useState<{ data_rules: string; ambiguity_rules: string; non_product_codes: string[] } | null>(null);
  const [schema, setSchema] = useState<{ tables: { name: string; columns: { name: string; type: string }[] }[]; row_count: number } | null>(null);
  useEffect(() => {
    api.rules().then(setRules);
    api.schema().then(setSchema);
  }, []);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h1 className="text-xl font-semibold">How RetailIQ treats messy retail data</h1>
        <p className="mt-1 text-sm text-slate-500">The same rules feed the agent prompt and the trap-suite reference SQL, so answers and tests use one definition.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {PLAIN_RULES.map((r) => (
            <div key={r.title} className="rounded-lg border border-slate-200 p-3">
              <div className="text-sm font-semibold">{r.title}</div>
              <p className="mt-1 text-sm text-slate-600">{r.body}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card min-w-0 p-5">
          <div className="text-sm font-semibold">Exact rules given to the agent</div>
          <pre className="mt-2 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
            {rules ? `${rules.data_rules}\n\n${rules.ambiguity_rules}` : "loading…"}
          </pre>
        </div>
        <div className="card min-w-0 p-5">
          <div className="text-sm font-semibold">Schema {schema && <span className="font-normal text-slate-500">· {schema.row_count.toLocaleString()} rows</span>}</div>
          <table className="mt-2 w-full text-left text-xs">
            <tbody>
              {schema?.tables[0].columns.map((c) => (
                <tr key={c.name} className="border-t border-slate-100">
                  <td className="py-1.5 font-mono">{c.name}</td>
                  <td className="py-1.5 text-slate-500">{c.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rules && <p className="mt-3 text-xs text-slate-500">Non-product codes: {rules.non_product_codes.join(", ")}, plus gift_*, TEST*, ADJUST*.</p>}
        </div>
      </div>
    </div>
  );
}
