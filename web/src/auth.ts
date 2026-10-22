// Session token from the backend (payload.signature). The payload is readable JSON;
// only the server can create a valid signature, and it checks it on every request.
const TOKEN_KEY = "datadukaan.token.v1";

export interface Session {
  email: string;
  iat: number;
  exp: number;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Without storage the user stays signed in for this tab only.
  }
  memoryToken = token;
  notify();
}

export function signOut() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  memoryToken = null;
  notify();
}

let memoryToken: string | null = null;

export function currentToken(): string | null {
  return memoryToken ?? getToken();
}

export function currentSession(): Session | null {
  const token = currentToken();
  if (!token) return null;
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const s = JSON.parse(atob(payload + "=".repeat((4 - (payload.length % 4)) % 4))) as Session;
    return s.exp * 1000 > Date.now() ? s : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}
export function onAuthChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
