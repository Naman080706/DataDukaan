import type { Health } from "../App";
import type { Session } from "../auth";

const TRUST: { term: string; body: string }[] = [
  {
    term: "Counted the same way every time",
    body: "Cancelled invoices, returns, customers without an ID and postage charges each have one written rule, and every answer follows it.",
  },
  {
    term: "Shows its working",
    body: "Every answer comes with the figures behind it and a plain note on what was counted and what was left out.",
  },
  {
    term: "Asks when a question is vague",
    body: "“Best customers” by revenue or by orders? “Last quarter” when the data stops in December? It asks instead of guessing.",
  },
  {
    term: "Checked against an answer key",
    body: "We wrote 18 tricky questions, including multi-part ones, and worked out the correct answers ourselves. DataDukaan gets all 18 right.",
  },
  {
    term: "Works on your own data too",
    body: "Add your own sales file or any table (CSV, Excel, JSON or Parquet) and ask about it instead. It's read in your browser and never uploaded.",
  },
  {
    term: "Looks, never touches",
    body: "It can read your sales records but never change or delete them. If the AI service is busy, it can still answer common questions.",
  },
];

export default function Landing({ session, health }: { session: Session | null; health: Health | null }) {
  const cta = session ? { href: "#/ask", label: "Start asking" } : { href: "#/signin", label: "Sign in to start" };
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
          {session ? "Start asking" : "Sign in"}
        </a>
      </header>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-8 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <h1 className="wide text-[clamp(36px,5.6vw,64px)] font-extrabold leading-[0.98] tracking-tight">Ask your shop's sales ledger anything.</h1>
          <p className="mt-6 max-w-xl text-[18px] leading-relaxed text-ink/80">
            Type a question the way you'd ask a colleague. DataDukaan works it out from two years of real sales records and shows you the
            answer, the figures behind it, and what it counted.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <a href={cta.href} className="btn-carbon px-6 py-3 text-[16px]">
              {cta.label}
            </a>
            <span className="text-[14px] text-muted">
              {health?.rows ? `${health.rows.toLocaleString("en-GB")} sales records, Dec 2009 to Dec 2011` : "UK online gift shop, Dec 2009 to Dec 2011"}
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
          <p className="margin-rule mt-5 text-[14px] leading-relaxed text-muted">
            Counted every order whose invoice number starts with “C”, the shop's mark for a cancellation. Each order is counted once, even if
            it had several items.
          </p>
        </figure>
      </section>

      <section className="border-t border-rule bg-sheet">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <h2 className="wide max-w-2xl text-[clamp(26px,3.4vw,36px)] font-extrabold leading-tight tracking-tight">
            Why you can trust the numbers
          </h2>
          <p className="mt-3 max-w-2xl text-[16px] leading-relaxed text-muted">
            Shop records are messy. Returns are mixed in with sales, cancelled orders stay in the books, and one in five sales has no
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
          Try “Which products were returned most?” and see how it tells returns apart from sales.
        </p>
        <a href={cta.href} className="btn-carbon px-6 py-3 text-[16px]">
          {cta.label}
        </a>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-muted sm:px-6">
          Data: Online Retail II, UCI Machine Learning Repository, CC BY 4.0. Built for NEXAI 2026. Answers are written with AI, so check the
          figures before acting on them.
        </div>
      </footer>
    </div>
  );
}
