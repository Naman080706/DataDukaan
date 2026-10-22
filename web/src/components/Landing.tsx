import type { Health } from "../App";
import type { Session } from "../auth";

const TRUST: { term: string; body: string }[] = [
  {
    term: "Counted the same way every time",
    body: "Cancelled invoices, returns, customers without an ID and postage lines each have one written rule, and every answer follows it.",
  },
  {
    term: "Shows its working",
    body: "Every answer comes with the exact SQL that produced it, the rows it returned, and each step the agent took.",
  },
  {
    term: "Asks when a question is vague",
    body: "“Best customers” by revenue or by orders? “Last quarter” when the data stops in December? It asks instead of guessing.",
  },
  {
    term: "Checked against an answer key",
    body: "15 trap questions with hand-written correct SQL. Gemini, Groq, the offline engine and the full chain all pass 15 of 15.",
  },
  {
    term: "Read-only, and still works when the AI doesn't",
    body: "It can't change the data. If every AI model is rate-limited, a rule engine answers common questions without AI.",
  },
];

export default function Landing({ session, health }: { session: Session | null; health: Health | null }) {
  const cta = session ? { href: "#/ask", label: "Open the ledger" } : { href: "#/signin", label: "Sign in to start" };
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <a href="#/" className="flex items-center gap-3">
          <img src="/icon-512.png" alt="" className="h-10 w-10 rounded-md" />
          <span className="wide text-[22px] font-extrabold tracking-tight">
            Data<span className="text-carbon">Dukaan</span>
          </span>
        </a>
        <a href={cta.href} className="text-[15px] font-semibold text-carbon-deep underline-offset-4 hover:underline">
          {session ? "Open the ledger" : "Sign in"}
        </a>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-8 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <h1 className="wide text-[clamp(36px,5.6vw,64px)] font-extrabold leading-[0.98] tracking-tight">Ask your shop's sales ledger anything.</h1>
          <p className="mt-6 max-w-xl text-[18px] leading-relaxed text-ink/80">
            Type a question in plain English. DataDukaan writes the SQL, runs it on two years of real invoices, and shows you the answer, the
            numbers behind it and exactly how it got there.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <a href={cta.href} className="btn-carbon px-6 py-3 text-[16px]">
              {cta.label}
            </a>
            <span className="text-[14px] text-muted">
              {health?.rows ? `${health.rows.toLocaleString("en-GB")} invoice lines, Dec 2009 to Dec 2011` : "UK online gift shop, Dec 2009 to Dec 2011"}
            </span>
          </div>
        </div>

        {/* A real answer from the data, shown the way the app shows it. */}
        <figure className="sheet relative px-6 py-6 sm:px-8" aria-label="Example answer">
          <p className="text-[15px] italic text-muted">“How many invoices were cancelled?”</p>
          <span className="stamp absolute right-6 top-5 text-ledger">Answered</span>
          <p className="mt-5 text-[22px] font-medium leading-snug">
            <span className="narrow text-[44px] font-extrabold leading-none">8,292</span>
            <br />
            invoices were cancelled. They start with “C” and are kept out of sales figures.
          </p>
          <pre className="carbon-copy mt-5 text-[12px]">
            {"SELECT COUNT(DISTINCT invoice) AS cancelled_invoices\nFROM transactions\nWHERE is_cancelled"}
          </pre>
          <figcaption className="mt-3 text-[13px] text-muted">Ran on a read-only copy of the data in a few milliseconds.</figcaption>
        </figure>
      </section>

      <section className="border-t border-rule bg-sheet">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="wide max-w-2xl text-[clamp(26px,3.4vw,36px)] font-extrabold leading-tight tracking-tight">
            Why you can trust the numbers
          </h2>
          <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-muted">
            Retail data is messy. Returns are recorded as negative quantities, cancelled orders stay in the books, and one in five lines has no
            customer. A confident wrong answer is worse than none.
          </p>
          <dl className="mt-8 border-t-[3px] border-double border-ink">
            {TRUST.map((t) => (
              <div key={t.term} className="grid gap-1 border-b border-rule py-5 md:grid-cols-[320px_1fr] md:gap-10">
                <dt className="text-[17px] font-bold">{t.term}</dt>
                <dd className="max-w-2xl text-[16px] leading-relaxed text-ink/80">{t.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-4 py-14 sm:px-6">
        <p className="wide max-w-xl text-[clamp(22px,2.8vw,30px)] font-extrabold leading-tight tracking-tight">
          Try “Which products were returned most?” and see what it does with the negative quantities.
        </p>
        <a href={cta.href} className="btn-carbon px-6 py-3 text-[16px]">
          {cta.label}
        </a>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-muted sm:px-6">
          Data: Online Retail II, UCI Machine Learning Repository, CC BY 4.0. Built for NEXAI 2026. Answers are written by an AI model from
          read-only SQL, so check the SQL before acting on a number.
        </div>
      </footer>
    </div>
  );
}
