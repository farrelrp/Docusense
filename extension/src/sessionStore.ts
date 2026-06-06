import { JobState, ProcessingResult, WarningResult } from "./api";

export const SESSION_STORAGE_KEY = "docusenseSession";

export interface PersistedSession {
  state: JobState;
  statusMessage: string;
  errorMessage: string;
  result: ProcessingResult | null;
  warning: WarningResult | null;
  startedAt: number | null;
  updatedAt: number;
}

export const DEFAULT_SESSION: PersistedSession = {
  state: "idle",
  statusMessage: "Ready to process a PDF.",
  errorMessage: "",
  result: null,
  warning: null,
  startedAt: null,
  updatedAt: Date.now(),
};

export function normalizeSession(value: unknown): PersistedSession {
  if (!value || typeof value !== "object") {
    return DEFAULT_SESSION;
  }

  return {
    ...DEFAULT_SESSION,
    ...(value as Partial<PersistedSession>),
  };
}

export async function readSession(): Promise<PersistedSession> {
  const chromeApi = globalThis.chrome;
  if (chromeApi?.storage?.session) {
    const data = await chromeApi.storage.session.get(SESSION_STORAGE_KEY);
    return normalizeSession(data[SESSION_STORAGE_KEY]);
  }

  const raw = localStorage.getItem(SESSION_STORAGE_KEY);
  return normalizeSession(raw ? JSON.parse(raw) : null);
}

export async function writeSession(session: PersistedSession): Promise<void> {
  const value = {
    ...session,
    updatedAt: Date.now(),
  };

  const chromeApi = globalThis.chrome;
  if (chromeApi?.storage?.session) {
    await chromeApi.storage.session.set({ [SESSION_STORAGE_KEY]: value });
    return;
  }

  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
}

export function subscribeToSessionChanges(
  callback: (session: PersistedSession) => void,
): () => void {
  const chromeApi = globalThis.chrome;
  if (!chromeApi?.storage?.onChanged) {
    return () => undefined;
  }

  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== "session" || !changes[SESSION_STORAGE_KEY]) {
      return;
    }

    callback(normalizeSession(changes[SESSION_STORAGE_KEY].newValue));
  };

  chromeApi.storage.onChanged.addListener(listener);
  return () => chromeApi.storage.onChanged.removeListener(listener);
}
