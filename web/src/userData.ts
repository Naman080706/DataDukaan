// Which dataset a signed-in user is asking about: the built-in one, or their own file kept in this browser.
// The file's bytes are stored in IndexedDB (per email) so it survives a reload; nothing is uploaded.
import { useEffect, useState } from "react";
import { api } from "./api";
import { DatasetProfile, loadDataset } from "./localdb";

const DB_NAME = "datadukaan-files";
const STORE = "files";
const activeKey = (email: string) => `datadukaan.useOwnData.v1.${email}`;

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const saveFile = (email: string, file: File) =>
  file.arrayBuffer().then((buf) => idbDo("readwrite", (s) => s.put({ name: file.name, type: file.type, buf }, email)));
const readFile = async (email: string): Promise<File | null> => {
  const rec = (await idbDo<{ name: string; type: string; buf: ArrayBuffer } | undefined>("readonly", (s) => s.get(email))) ?? null;
  return rec ? new File([rec.buf], rec.name, { type: rec.type }) : null;
};
const deleteFile = (email: string) => idbDo("readwrite", (s) => s.delete(email));

let nonProduct: string[] | null = null;
async function nonProductCodes() {
  if (!nonProduct) nonProduct = (await api.rules()).non_product_codes;
  return nonProduct;
}

// ---------- shared state (one per tab) ----------

export interface UserDataState {
  status: "none" | "loading" | "ready" | "error";
  profile: DatasetProfile | null;
  active: boolean; // true = questions use the user's file
  error: string | null;
}

let state: UserDataState = { status: "none", profile: null, active: false, error: null };
let loadedFor: string | null = null;
const listeners = new Set<() => void>();
function set(next: Partial<UserDataState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function readActive(email: string) {
  try {
    return localStorage.getItem(activeKey(email)) === "1";
  } catch {
    return false;
  }
}
function writeActive(email: string, on: boolean) {
  try {
    if (on) localStorage.setItem(activeKey(email), "1");
    else localStorage.removeItem(activeKey(email));
  } catch {
    // ignore
  }
}

/** Load the user's stored file (if any) the first time the app needs it. */
async function restore(email: string) {
  if (loadedFor === email) return;
  loadedFor = email;
  state = { status: "none", profile: null, active: false, error: null };
  try {
    const file = await readFile(email);
    if (!file) return set({ status: "none" });
    set({ status: "loading" });
    const profile = await loadDataset(file, await nonProductCodes());
    set({ status: "ready", profile, active: readActive(email) });
  } catch (e) {
    set({ status: "error", error: `Your saved file couldn't be opened again: ${e instanceof Error ? e.message : e}` });
  }
}

export async function useFile(email: string, file: File) {
  set({ status: "loading", error: null });
  try {
    const profile = await loadDataset(file, await nonProductCodes());
    await saveFile(email, file).catch(() => undefined); // too big for browser storage: works until reload
    writeActive(email, true);
    set({ status: "ready", profile, active: true });
  } catch (e) {
    set({ status: state.profile ? "ready" : "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export function setActive(email: string, on: boolean) {
  writeActive(email, on);
  set({ active: on && !!state.profile });
}

export async function removeFile(email: string) {
  await deleteFile(email).catch(() => undefined);
  writeActive(email, false);
  set({ status: "none", profile: null, active: false, error: null });
}

export function useUserData(email: string | null): UserDataState {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (email) restore(email);
    return () => {
      listeners.delete(l);
    };
  }, [email]);
  return email ? state : { status: "none", profile: null, active: false, error: null };
}
