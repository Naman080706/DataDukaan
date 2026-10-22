import { useEffect, useState } from "react";
import { api } from "./api";
import { currentSession, onAuthChange, Session } from "./auth";
import Workspace from "./components/Workspace";
import Evaluation from "./components/Evaluation";
import DataRules from "./components/DataRules";
import Landing from "./components/Landing";
import SignIn from "./components/SignIn";
import Profile from "./components/Profile";
import { loadProfile } from "./storage";

// Hash routes keep this a static site (no server rewrites needed on Vercel).
type Route = "home" | "signin" | "ask" | "tests" | "rules" | "profile";
const ROUTES: Record<string, Route> = {
  "": "home", "#/": "home", "#/signin": "signin", "#/ask": "ask", "#/tests": "tests", "#/rules": "rules", "#/profile": "profile",
};
const NEEDS_SIGN_IN: Route[] = ["ask", "tests", "rules", "profile"];

const NAV: { route: Route; label: string }[] = [
  { route: "ask", label: "Ask" },
  { route: "tests", label: "Trap tests" },
  { route: "rules", label: "How we count" },
];

export type Health = { status: string; rows?: number; llm_configured?: boolean; email_sign_in?: boolean };

export function go(route: Route) {
  window.location.hash = route === "home" ? "#/" : `#/${route}`;
}

function readRoute(): Route {
  return ROUTES[window.location.hash] ?? "home";
}

export default function App() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [session, setSession] = useState<Session | null>(currentSession);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    const off = onAuthChange(() => setSession(currentSession()));
    api.health().then(setHealth).catch(() => setHealth({ status: "down" }));
    return () => {
      window.removeEventListener("hashchange", onHash);
      off();
    };
  }, []);

  // Pages that need an account send signed-out visitors to sign in, and come back afterwards.
  const blocked = NEEDS_SIGN_IN.includes(route) && !session;
  useEffect(() => {
    if (blocked) {
      try {
        sessionStorage.setItem("datadukaan.after-sign-in", route);
      } catch {
        // ignore
      }
      go("signin");
    }
  }, [blocked, route]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);

  if (route === "home") return <Landing session={session} health={health} />;
  if (route === "signin" || blocked) return <SignIn health={health} />;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-x-10 gap-y-3 px-4 pb-0 pt-5 sm:px-6">
          <a href="#/" className="flex items-center gap-3 pb-3">
            <img src="/icon-512.png" alt="" className="h-10 w-10 rounded-md" />
            <span>
              <span className="wide block text-[24px] font-extrabold leading-none tracking-tight">
                Data<span className="text-carbon">Dukaan</span>
              </span>
              <span className="mt-1 block text-[13px] text-muted">Ask the shop's sales ledger in plain English</span>
            </span>
          </a>
          <nav className="flex flex-1 gap-6" role="tablist">
            {NAV.map(({ route: r, label }) => (
              <a key={r} href={`#/${r}`} role="tab" aria-selected={route === r} className="tab text-[15px]">
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-end gap-6 pb-3">
            <DatasetStatus health={health} />
            {session && <ProfileLink email={session.email} active={route === "profile"} />}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {route === "ask" && session && <Workspace key={session.email} email={session.email} />}
        {route === "tests" && <Evaluation />}
        {route === "rules" && <DataRules />}
        {route === "profile" && session && <Profile session={session} />}
      </main>
      <footer className="mx-auto w-full max-w-6xl px-4 pb-6 text-xs leading-relaxed text-muted sm:px-6">
        Data: Online Retail II, UCI Machine Learning Repository, CC BY 4.0. A UK online gift shop, December 2009 to December 2011, prices in
        pounds sterling. Answers are written by an AI model from read-only SQL, so check the SQL before acting on a number.
      </footer>
    </div>
  );
}

function ProfileLink({ email, active }: { email: string; active: boolean }) {
  const [name, setName] = useState(() => loadProfile(email).name);
  useEffect(() => {
    const update = () => setName(loadProfile(email).name);
    window.addEventListener("datadukaan:profile", update);
    return () => window.removeEventListener("datadukaan:profile", update);
  }, [email]);
  const initial = (name || email)[0].toUpperCase();
  return (
    <a
      href="#/profile"
      aria-label="Your profile"
      className={`flex items-center gap-2 text-[13px] ${active ? "text-carbon-deep" : "text-muted hover:text-ink"}`}
    >
      <span className={`grid h-8 w-8 place-items-center rounded-full font-bold ${active ? "bg-carbon-deep text-white" : "bg-carbon-wash text-carbon-deep"}`}>
        {initial}
      </span>
      <span className="hidden max-w-[160px] truncate lg:inline">{name || email}</span>
    </a>
  );
}

function DatasetStatus({ health }: { health: Health | null }) {
  if (!health) return <span className="text-[13px] text-muted">Opening the ledger…</span>;
  if (health.status !== "ok") return <span className="text-[13px] font-medium text-stamp">Ledger offline. Check the API server.</span>;
  return (
    <span className="text-[13px] leading-tight text-muted sm:text-right">
      <span className="narrow text-[17px] font-bold text-ink">{health.rows?.toLocaleString("en-GB")}</span> invoice lines
      <br />
      read-only{!health.llm_configured && <span className="text-stamp">, AI key missing</span>}
    </span>
  );
}
