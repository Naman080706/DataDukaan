import type { AskResponse } from "./api";

// Per-browser persistence. Storage can be missing or full (private windows, quotas),
// so every access is wrapped and the app works without it.
// Keys are per email, so two people signing in on one browser don't see each other's history.
const key = (name: string, email: string) => `datadukaan.${name}.v1.${email}`;
const MAX_ROWS = 200;
const MAX_SAVED = 50;

export interface StoredEntry {
  question: string;
  response?: AskResponse;
  error?: string;
}

export interface SavedAnalysis {
  id: string;
  savedAt: string;
  question: string;
  response: AskResponse;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: keep working in memory only.
  }
}

const slim = (r: AskResponse): AskResponse => ({ ...r, rows: r.rows.slice(0, MAX_ROWS) });

export function loadSession(email: string): { conversationId: string; entries: StoredEntry[] } | null {
  return read(key("session", email), null);
}

export function saveSession(email: string, conversationId: string, entries: StoredEntry[]) {
  // Unfinished requests are not stored; they could never complete after a reload.
  const done = entries.filter((e) => e.response || e.error).map((e) => (e.response ? { ...e, response: slim(e.response) } : e));
  write(key("session", email), { conversationId, entries: done });
}

export function loadSaved(email: string): SavedAnalysis[] {
  return read<SavedAnalysis[]>(key("saved", email), []);
}

export function storeSaved(email: string, items: SavedAnalysis[]) {
  write(key("saved", email), items.slice(0, MAX_SAVED).map((s) => ({ ...s, response: slim(s.response) })));
}

export interface Profile {
  name: string;
  role: string;
  store: string;
}

export function loadProfile(email: string): Profile {
  return read<Profile>(key("profile", email), { name: "", role: "", store: "" });
}

export function storeProfile(email: string, profile: Profile) {
  write(key("profile", email), profile);
  window.dispatchEvent(new Event("datadukaan:profile"));
}
