import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api";
import { setToken } from "../auth";
import type { Health } from "../App";

type Step = { kind: "email" } | { kind: "code"; email: string; challenge: string; sentAt: number };

function afterSignIn() {
  let next = "ask";
  try {
    next = sessionStorage.getItem("datadukaan.after-sign-in") || "ask";
    sessionStorage.removeItem("datadukaan.after-sign-in");
  } catch {
    // ignore
  }
  window.location.hash = `#/${next}`;
}

export default function SignIn({ health }: { health: Health | null }) {
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step.kind === "code") codeRef.current?.focus();
  }, [step.kind]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function sendCode(to: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.requestCode(to);
      setStep({ kind: "code", email: to.trim().toLowerCase(), challenge: r.challenge, sentAt: Date.now() });
      setCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (step.kind !== "code") return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifyCode(step.challenge, code);
      setToken(r.token);
      afterSignIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const resendIn = step.kind === "code" ? Math.max(0, 45 - Math.floor((now - step.sentAt) / 1000)) : 0;
  const notSetUp = health?.status === "ok" && health.email_sign_in === false;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center px-4 py-5 sm:px-6">
        <a href="#/" className="flex items-center gap-3">
          <img src="/icon-512.png" alt="" className="h-10 w-10 rounded-md" />
          <span className="wide text-[22px] font-extrabold tracking-tight">
            Data<span className="text-carbon">Dukaan</span>
          </span>
        </a>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-4 pb-16 pt-6">
        <div className="sheet px-6 py-8 sm:px-8">
          <h1 className="wide text-[30px] font-extrabold leading-tight tracking-tight">Sign in</h1>

          {step.kind === "email" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendCode(email);
              }}
              className="mt-2"
            >
              <p className="text-[15px] leading-relaxed text-muted">We'll email you a 6-digit code. No password needed.</p>
              <label htmlFor="email" className="mt-6 block text-sm font-semibold">
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@shop.com"
                className="mt-1.5 w-full border-b-2 border-ink bg-transparent px-1 py-2 text-[17px] outline-none placeholder:text-muted/60 focus:border-carbon-deep"
              />
              <button disabled={busy || !email.trim()} className="btn-carbon mt-6 flex w-full items-center justify-center gap-2 py-2.5 text-[15px]">
                {busy && <Loader2 size={16} className="animate-spin" />}
                {busy ? "Sending code" : "Email me a code"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verify();
              }}
              className="mt-2"
            >
              <p className="text-[15px] leading-relaxed text-muted">
                We sent a code to <span className="font-semibold text-ink">{step.email}</span>. It works for 10 minutes. Check spam if it
                doesn't arrive.
              </p>
              <label htmlFor="code" className="mt-6 block text-sm font-semibold">
                6-digit code
              </label>
              <input
                id="code"
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="narrow mt-1.5 w-full border-b-2 border-ink bg-transparent px-1 py-1 text-[34px] font-bold tracking-[0.35em] outline-none focus:border-carbon-deep"
              />
              <button disabled={busy || code.length !== 6} className="btn-carbon mt-6 flex w-full items-center justify-center gap-2 py-2.5 text-[15px]">
                {busy && <Loader2 size={16} className="animate-spin" />}
                {busy ? "Checking" : "Sign in"}
              </button>
              <div className="mt-4 flex justify-between text-[13px]">
                <button
                  type="button"
                  onClick={() => {
                    setStep({ kind: "email" });
                    setError(null);
                  }}
                  className="text-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  Use a different email
                </button>
                <button
                  type="button"
                  disabled={resendIn > 0 || busy}
                  onClick={() => sendCode(step.email)}
                  className="font-medium text-carbon-deep underline-offset-2 hover:underline disabled:text-muted disabled:no-underline"
                >
                  {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
                </button>
              </div>
            </form>
          )}

          {error && (
            <p role="alert" className="mt-5 border-l-2 border-stamp pl-3 text-[14px] text-stamp">
              {error}
            </p>
          )}
          {notSetUp && !error && (
            <p className="mt-5 border-l-2 border-gold pl-3 text-[14px] text-gold-deep">
              Email sign-in isn't set up on this server yet, so codes can't be sent.
            </p>
          )}
        </div>
        <p className="mt-6 text-center text-[13px] text-muted">
          Signing in keeps your questions and saved analyses under your email, in this browser.
        </p>
      </main>
    </div>
  );
}
