import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { MAX_FILE_MB } from "../localdb";
import { openFile, removeFile, setActive, UserDataState } from "../userData";
import { SortableTable } from "./ResultView";

const TYPE_WORDS: [RegExp, string][] = [
  [/^(DATE|TIMESTAMP|TIME)/, "date"],
  [/^(DOUBLE|FLOAT|REAL|DECIMAL|HUGEINT|BIGINT|INTEGER|SMALLINT|TINYINT|UBIGINT|UINTEGER)/, "number"],
  [/^BOOLEAN/, "yes / no"],
];
const typeWord = (t: string) => TYPE_WORDS.find(([re]) => re.test(t))?.[1] ?? "text";

export default function YourData({ email, data }: { email: string; data: UserDataState }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const p = data.profile;

  function pick(files: FileList | null) {
    const f = files?.[0];
    if (f) openFile(email, f);
  }

  return (
    <div className="space-y-6">
      <section className="sheet px-5 py-7 sm:px-8">
        <h1 className="wide max-w-3xl text-[clamp(26px,3.6vw,38px)] font-extrabold leading-[1.05] tracking-tight">Ask about your own data</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Add a sales file, or any other table, and DataDukaan will answer questions about it instead of the built-in gift-shop data. Your file
          stays on this computer: it is read inside your browser and never uploaded. Only the column names, five example rows and the figures in
          each answer are sent to the AI.
        </p>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
          className={`mt-6 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? "border-carbon bg-carbon-wash/40" : "border-rule hover:border-carbon hover:bg-carbon-wash/20"
          }`}
        >
          <input
            ref={input}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,.json,.jsonl,.ndjson,.parquet"
            className="sr-only"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
          {data.status === "loading" ? (
            <span className="flex items-center gap-2 text-[16px] font-semibold">
              <Loader2 size={18} className="animate-spin text-carbon-deep" /> Reading your file…
            </span>
          ) : (
            <>
              <span className="text-[17px] font-semibold">{p ? "Choose a different file" : "Choose a file or drop it here"}</span>
              <span className="text-[14px] text-muted">CSV, Excel (.xlsx, .xls), JSON or Parquet, up to {MAX_FILE_MB} MB</span>
            </>
          )}
        </label>
        {data.error && (
          <p role="alert" className="mt-4 border-l-2 border-stamp pl-3 text-[14px] text-stamp">
            {data.error}
          </p>
        )}
      </section>

      {p && (
        <section className="sheet px-5 py-7 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate text-[20px] font-bold">{p.source}</h2>
              <p className="mt-1 text-[14px] text-muted">
                <span className="narrow text-[17px] font-bold text-ink">{p.row_count.toLocaleString("en-GB")}</span> rows,{" "}
                {p.columns.length} columns
                {p.date_range[0] && `, ${String(p.date_range[0]).slice(0, 10)} to ${String(p.date_range[1]).slice(0, 10)}`}
              </p>
            </div>
            <span className={`stamp stamp-sm ${p.kind === "retail" ? "text-ledger" : "text-gold-deep"}`}>
              {p.kind === "retail" ? "Sales data" : "General table"}
            </span>
          </div>

          <p className="margin-rule mt-4 max-w-3xl text-[14px] leading-relaxed text-muted">
            {p.kind === "retail"
              ? "Recognised as sales data, so the same counting rules apply: returns and cancellations are kept apart from sales, postage and fees are left out of product rankings, and backup mode works if the AI is busy. Negative quantities are treated as returns."
              : "This doesn't look like sales data, so DataDukaan will work out what each column means from its name and a few example rows, and tell you how it read them in each answer."}
          </p>

          <fieldset className="mt-6">
            <legend className="text-sm font-semibold">Answer questions using</legend>
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-2 text-[15px]">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="which" checked={data.active} onChange={() => setActive(email, true)} className="accent-carbon-deep" />
                My file
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="radio" name="which" checked={!data.active} onChange={() => setActive(email, false)} className="accent-carbon-deep" />
                The built-in gift-shop data
              </label>
            </div>
          </fieldset>
          {data.active && (
            <a href="#/ask" className="btn-carbon mt-5 inline-block">
              Ask about {p.source}
            </a>
          )}

          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.4fr]">
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-semibold">{p.kind === "retail" ? "How your columns were read" : "Columns"}</h3>
              <table className="ledger w-full text-[13.5px]">
                <thead>
                  <tr>
                    <th>{p.kind === "retail" ? "Used as" : "Column"}</th>
                    <th>{p.kind === "retail" ? "Your column" : "Kind"}</th>
                  </tr>
                </thead>
                <tbody>
                  {p.kind === "retail"
                    ? p.mapping.map((m) => (
                        <tr key={m.field}>
                          <td>{m.field}</td>
                          <td className="font-mono text-[12.5px]">{m.column}</td>
                        </tr>
                      ))
                    : p.columns.map((c) => (
                        <tr key={c.name}>
                          <td className="font-mono text-[12.5px]">{c.name}</td>
                          <td className="text-muted">{typeWord(c.type)}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-semibold">First rows</h3>
              {/* For sales data, show the user's own fields, not the helper columns DataDukaan adds. */}
              <SortableTable
                columns={p.columns.map((c) => c.name).slice(0, p.kind === "retail" ? 8 : undefined)}
                rows={p.sample_rows.map((r) => r.slice(0, p.kind === "retail" ? 8 : undefined))}
                exportable={false}
                currency=""
              />
            </div>
          </div>

          <button
            onClick={() => removeFile(email)}
            className="mt-8 text-[14px] font-medium text-stamp underline-offset-2 hover:underline"
          >
            Remove my file
          </button>
          <p className="mt-2 text-[13px] text-muted">
            Removing it deletes the copy kept in this browser and switches back to the built-in data. The trap tests always use the built-in data.
          </p>
        </section>
      )}
    </div>
  );
}
