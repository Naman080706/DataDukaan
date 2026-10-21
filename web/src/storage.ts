import type { AskResponse } from "./api";

// Per-browser persistence. Storage can be missing or full (private windows, quotas),
// so every access is wrapped and the app works without it.
const SESSION_KEY = "datadukaan.session.v1";
const SAVED_KEY = "datadukaan.saved.v1";
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

export function loadSession(): { conversationId: string; entries: StoredEntry[] } | null {
  return read(SESSION_KEY, null);
}

export function saveSession(conversationId: string, entries: StoredEntry[]) {
  // Unfinished requests are not stored; they could never complete after a reload.
  const done = entries.filter((e) => e.response || e.error).map((e) => (e.response ? { ...e, response: slim(e.response) } : e));
  write(SESSION_KEY, { conversationId, entries: done });
}

export function loadSaved(): SavedAnalysis[] {
  return read<SavedAnalysis[]>(SAVED_KEY, []);
}

export function storeSaved(items: SavedAnalysis[]) {
  write(SAVED_KEY, items.slice(0, MAX_SAVED).map((s) => ({ ...s, response: slim(s.response) })));
}
