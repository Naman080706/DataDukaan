import { useState } from "react";
import { signOut, Session } from "../auth";
import { loadProfile, loadSaved, loadSession, Profile as ProfileData, storeProfile, storeSaved } from "../storage";

const FIELDS: { key: keyof ProfileData; label: string; placeholder: string }[] = [
  { key: "name", label: "Name", placeholder: "Your name" },
  { key: "role", label: "Role", placeholder: "Store manager, analyst…" },
  { key: "store", label: "Store or team", placeholder: "Which shop or team you work for" },
];

export default function Profile({ session }: { session: Session }) {
  const { email } = session;
  const [profile, setProfile] = useState<ProfileData>(() => loadProfile(email));
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [saved, setSaved] = useState(() => loadSaved(email));
  const asked = loadSession(email)?.entries.length ?? 0;
  const fmt = (s: number) => new Date(s * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  function save() {
    storeProfile(email, profile);
    setSavedNote("Saved");
    setTimeout(() => setSavedNote(null), 1800);
  }

  function remove(id: string) {
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    storeSaved(email, next);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <section className="sheet px-5 py-7 sm:px-8">
        <div className="flex items-center gap-4">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-carbon-deep text-[24px] font-bold text-white">
            {(profile.name || email)[0].toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="wide truncate text-[26px] font-extrabold leading-tight tracking-tight">{profile.name || "Your profile"}</h1>
            <p className="truncate text-[15px] text-muted">{email}</p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="mt-8 space-y-5"
        >
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.key} className="block text-sm font-semibold">
                {f.label}
              </label>
              <input
                id={f.key}
                value={profile[f.key]}
                maxLength={80}
                onChange={(e) => setProfile({ ...profile, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                className="mt-1.5 w-full border-b-2 border-rule bg-transparent px-1 py-2 text-[16px] outline-none placeholder:text-muted/60 focus:border-carbon-deep"
              />
            </div>
          ))}
          <div className="flex items-center gap-4 pt-2">
            <button className="btn-carbon">Save profile</button>
            {savedNote && <span className="text-[14px] text-ledger">{savedNote}</span>}
          </div>
          <p className="text-[13px] text-muted">Your profile is stored in this browser only.</p>
        </form>

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 border-t-[3px] border-double border-ink pt-5 text-[14px]">
          <div>
            <dt className="text-muted">Signed in on</dt>
            <dd className="font-semibold">{fmt(session.iat)}</dd>
          </div>
          <div>
            <dt className="text-muted">Sign-in lasts until</dt>
            <dd className="font-semibold">{fmt(session.exp)}</dd>
          </div>
          <div>
            <dt className="text-muted">Questions this session</dt>
            <dd className="narrow text-[22px] font-extrabold">{asked}</dd>
          </div>
          <div>
            <dt className="text-muted">Saved analyses</dt>
            <dd className="narrow text-[22px] font-extrabold">{saved.length}</dd>
          </div>
        </dl>

        <button
          onClick={() => {
            // Leave the page first, so the sign-in guard doesn't send the signed-out profile page to sign-in.
            window.addEventListener("hashchange", () => signOut(), { once: true });
            window.location.hash = "#/";
          }}
          className="mt-8 text-[14px] font-medium text-stamp underline-offset-2 hover:underline"
        >
          Sign out
        </button>
      </section>

      <section className="sheet px-5 py-7 sm:px-8">
        <h2 className="text-lg font-bold">Saved analyses</h2>
        {saved.length === 0 ? (
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Nothing saved yet. On the <a href="#/ask" className="font-medium text-carbon-deep underline-offset-2 hover:underline">Ask</a> page, use
            “Save this analysis” under any answer to keep it here.
          </p>
        ) : (
          <ul className="mt-3">
            {saved.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-4 border-b border-rule py-3">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium leading-snug">{s.question}</p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    Saved {new Date(s.savedAt).toLocaleDateString("en-GB")}, {s.response.rows.length} rows
                  </p>
                </div>
                <button onClick={() => remove(s.id)} className="shrink-0 text-[13px] text-muted underline-offset-2 hover:text-stamp hover:underline">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
