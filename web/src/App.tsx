import { useEffect, useState } from "react";
import { api } from "./api";
import Workspace from "./components/Workspace";
import Evaluation from "./components/Evaluation";
import DataRules from "./components/DataRules";

type Page = "workspace" | "evaluation" | "rules";

const NAV: { id: Page; label: string }[] = [
  { id: "workspace", label: "Ask" },
  { id: "evaluation", label: "Trap tests" },
  { id: "rules", label: "How we count" },
];

export default function App() {
  const [page, setPage] = useState<Page>("workspace");
  const [health, setHealth] = useState<{ status: string; rows?: number; llm_configured?: boolean } | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ status: "down" }));
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-x-10 gap-y-3 px-4 pb-0 pt-5 sm:px-6">
          <div className="pb-3">
            <div className="wide text-[26px] font-extrabold leading-none tracking-tight">
              Data<span className="text-carbon">Dukaan</span>
            </div>
            <div className="mt-1 text-[13px] text-muted">Ask the shop's sales ledger in plain English</div>
          </div>
          <nav className="flex flex-1 gap-6" role="tablist">
            {NAV.map(({ id, label }) => (
              <button key={id} role="tab" aria-selected={page === id} onClick={() => setPage(id)} className="tab text-[15px]">
                {label}
              </button>
            ))}
          </nav>
          <DatasetStatus health={health} />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {page === "workspace" && <Workspace />}
        {page === "evaluation" && <Evaluation />}
        {page === "rules" && <DataRules />}
      </main>
      <footer className="mx-auto w-full max-w-6xl px-4 pb-6 text-xs leading-relaxed text-muted sm:px-6">
        Data: Online Retail II, UCI Machine Learning Repository, CC BY 4.0. A UK online gift shop, December 2009 to December 2011, prices in
        pounds sterling. Answers are written by an AI model from read-only SQL, so check the SQL before acting on a number.
      </footer>
    </div>
  );
}

function DatasetStatus({ health }: { health: { status: string; rows?: number; llm_configured?: boolean } | null }) {
  if (!health) return <span className="pb-3 text-[13px] text-muted">Opening the ledger…</span>;
  if (health.status !== "ok") return <span className="pb-3 text-[13px] font-medium text-stamp">Ledger offline. Check the API server.</span>;
  return (
    <span className="pb-3 text-[13px] leading-tight text-muted sm:text-right">
      <span className="narrow text-[17px] font-bold text-ink">{health.rows?.toLocaleString("en-GB")}</span> invoice lines
      <br />
      read-only{!health.llm_configured && <span className="text-stamp">, AI key missing</span>}
    </span>
  );
}
