export const PLAYER_STORAGE_KEY = "docusensePlayer";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerSection {
  id: string;
  label: string;
}

export interface PlayerState {
  documentId: string;
  sections: PlayerSection[];
  currentIndex: number;
  status: PlayerStatus;
  statusMessage: string;
  currentTime: number;
  duration: number;
  updatedAt: number;
}

export const DEFAULT_PLAYER_STATE: PlayerState = {
  documentId: "",
  sections: [],
  currentIndex: 0,
  status: "idle",
  statusMessage: "Ready to read.",
  currentTime: 0,
  duration: 0,
  updatedAt: Date.now(),
};

export function normalizePlayerState(value: unknown): PlayerState {
  if (!value || typeof value !== "object") {
    return DEFAULT_PLAYER_STATE;
  }
  return {
    ...DEFAULT_PLAYER_STATE,
    ...(value as Partial<PlayerState>),
  };
}

export async function readPlayerState(): Promise<PlayerState> {
  const data = await chrome.storage.local.get(PLAYER_STORAGE_KEY);
  return normalizePlayerState(data[PLAYER_STORAGE_KEY]);
}

export function subscribeToPlayerChanges(callback: (state: PlayerState) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName === "local" && changes[PLAYER_STORAGE_KEY]) {
      callback(normalizePlayerState(changes[PLAYER_STORAGE_KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
