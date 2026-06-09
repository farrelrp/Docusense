import { PlayerCommand } from "./messages";
import { synthesizeWithMicrosoftReadAloud } from "./microsoftReadAloud";
import {
  DEFAULT_PLAYER_STATE,
  PLAYER_STORAGE_KEY,
  PlayerState,
  readPlayerState,
} from "./playerStore";
import { ReaderChapter } from "./readerChapters";

const PLAYER_QUEUE_STORAGE_KEY = "docusensePlayerQueue";

interface PersistedPlayerQueue {
  documentId: string;
  chapters: ReaderChapter[];
}

let chapters: ReaderChapter[] = [];
let state: PlayerState = DEFAULT_PLAYER_STATE;
let audio: HTMLAudioElement | null = null;
let desiredPlayback = false;
let generation = 0;
let queueVersion = 0;
let lastProgressWrite = 0;
const audioUrls = new Map<number, string>();
const pendingAudio = new Map<number, Promise<string>>();
const initialization = Promise.all([
  readPlayerState(),
  chrome.storage.local.get(PLAYER_QUEUE_STORAGE_KEY),
]).then(([savedState, queueData]) => {
  const savedQueue = queueData[PLAYER_QUEUE_STORAGE_KEY] as PersistedPlayerQueue | undefined;
  state = savedState.status === "playing" || savedState.status === "loading"
    ? {
        ...savedState,
        status: "paused",
        statusMessage: "Playback is ready to resume.",
      }
    : savedState;
  if (savedQueue?.documentId === state.documentId) {
    chapters = savedQueue.chapters;
  }
  return chrome.storage.local.set({ [PLAYER_STORAGE_KEY]: state });
});

async function saveState(patch: Partial<PlayerState>): Promise<void> {
  state = {
    ...state,
    ...patch,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [PLAYER_STORAGE_KEY]: state });
}

function releaseAudioCache(): void {
  for (const url of audioUrls.values()) {
    URL.revokeObjectURL(url);
  }
  audioUrls.clear();
  pendingAudio.clear();
}

function detachAudio(): void {
  if (!audio) {
    return;
  }
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audio = null;
}

function synthesizeSection(index: number): Promise<string> {
  const cached = audioUrls.get(index);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = pendingAudio.get(index);
  if (pending) {
    return pending;
  }

  const section = chapters[index];
  if (!section) {
    return Promise.reject(new Error("That section is unavailable."));
  }

  const requestVersion = queueVersion;
  let request: Promise<string>;
  request = synthesizeWithMicrosoftReadAloud(section.text, {
    voiceName: "en-US-JennyNeural",
    rate: "+0%",
  })
    .then((url) => {
      if (requestVersion !== queueVersion) {
        URL.revokeObjectURL(url);
        throw new DOMException("The document changed during synthesis.", "AbortError");
      }
      audioUrls.set(index, url);
      return url;
    })
    .finally(() => {
      if (pendingAudio.get(index) === request) {
        pendingAudio.delete(index);
      }
    });
  pendingAudio.set(index, request);
  return request;
}

function prefetch(index: number): void {
  if (index >= 0 && index < chapters.length) {
    void synthesizeSection(index).catch(() => undefined);
  }
}

async function playIndex(index: number, startTime = 0): Promise<void> {
  if (!chapters[index]) {
    return;
  }

  const requestGeneration = ++generation;
  desiredPlayback = true;
  detachAudio();
  await saveState({
    currentIndex: index,
    status: "loading",
    statusMessage: `Preparing ${chapters[index].label}...`,
    currentTime: startTime,
    duration: startTime > 0 ? state.duration : 0,
  });

  try {
    const url = await synthesizeSection(index);
    if (requestGeneration !== generation || !desiredPlayback) {
      return;
    }

    const nextAudio = new Audio(url);
    audio = nextAudio;
    nextAudio.preload = "auto";
    nextAudio.onloadedmetadata = () => {
      if (startTime > 0) {
        nextAudio.currentTime = Math.min(startTime, nextAudio.duration || startTime);
      }
      void saveState({
        currentTime: nextAudio.currentTime,
        duration: Number.isFinite(nextAudio.duration) ? nextAudio.duration : 0,
      });
    };
    nextAudio.ontimeupdate = () => {
      const now = Date.now();
      if (now - lastProgressWrite < 500) {
        return;
      }
      lastProgressWrite = now;
      void saveState({
        currentTime: nextAudio.currentTime,
        duration: Number.isFinite(nextAudio.duration) ? nextAudio.duration : state.duration,
      });
    };
    nextAudio.onplay = () => {
      void saveState({
        status: "playing",
        statusMessage: `Reading ${chapters[index].label}.`,
      });
    };
    nextAudio.onpause = () => {
      if (!nextAudio.ended && !desiredPlayback) {
        void saveState({
          status: "paused",
          statusMessage: `Paused at ${chapters[index].label}.`,
          currentTime: nextAudio.currentTime,
        });
      }
    };
    nextAudio.onended = () => {
      if (index + 1 < chapters.length) {
        void playIndex(index + 1);
      } else {
        desiredPlayback = false;
        void saveState({
          status: "idle",
          statusMessage: "Finished reading the document.",
          currentTime: nextAudio.duration || state.duration,
        });
      }
    };
    nextAudio.onerror = () => {
      desiredPlayback = false;
      void saveState({
        status: "error",
        statusMessage: `Could not play ${chapters[index].label}.`,
      });
    };

    await nextAudio.play();
    prefetch(index + 1);
  } catch (error) {
    if (requestGeneration !== generation) {
      return;
    }
    desiredPlayback = false;
    await saveState({
      status: "error",
      statusMessage:
        error instanceof Error ? error.message : "Microsoft Read Aloud is unavailable.",
    });
  }
}

async function handleCommand(command: PlayerCommand): Promise<void> {
  await initialization;

  if (command.type === "DOCUSENSE_PLAYER_LOAD") {
    if (state.documentId === command.documentId && chapters.length > 0) {
      return;
    }
    generation += 1;
    queueVersion += 1;
    desiredPlayback = false;
    detachAudio();
    releaseAudioCache();
    chapters = command.chapters;
    await chrome.storage.local.set({
      [PLAYER_QUEUE_STORAGE_KEY]: {
        documentId: command.documentId,
        chapters,
      } satisfies PersistedPlayerQueue,
    });
    await saveState({
      ...DEFAULT_PLAYER_STATE,
      documentId: command.documentId,
      sections: chapters.map(({ id, label }) => ({ id, label })),
      statusMessage: chapters.length > 0 ? "Ready to read." : "No readable sections found.",
    });
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_PLAY") {
    if (audio && state.status === "paused") {
      desiredPlayback = true;
      await audio.play();
      return;
    }
    await playIndex(state.currentIndex, state.status === "paused" ? state.currentTime : 0);
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_PAUSE") {
    desiredPlayback = false;
    if (state.status === "loading") {
      generation += 1;
      detachAudio();
      await saveState({
        status: "paused",
        statusMessage: `Paused at ${chapters[state.currentIndex]?.label ?? "the document"}.`,
      });
    } else {
      audio?.pause();
    }
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_NEXT") {
    const nextIndex = Math.min(state.currentIndex + 1, chapters.length - 1);
    if (nextIndex !== state.currentIndex) {
      if (state.status === "playing" || state.status === "loading") {
        await playIndex(nextIndex);
      } else {
        generation += 1;
        detachAudio();
        await saveState({
          currentIndex: nextIndex,
          currentTime: 0,
          duration: 0,
          status: "paused",
          statusMessage: `Selected ${chapters[nextIndex].label}.`,
        });
      }
    }
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_PREVIOUS") {
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      await saveState({ currentTime: 0 });
      return;
    }
    const previousIndex = Math.max(state.currentIndex - 1, 0);
    if (state.status === "playing" || state.status === "loading") {
      await playIndex(previousIndex);
    } else {
      generation += 1;
      detachAudio();
      await saveState({
        currentIndex: previousIndex,
        currentTime: 0,
        duration: 0,
        status: "paused",
        statusMessage: `Selected ${chapters[previousIndex].label}.`,
      });
    }
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_SELECT" && chapters[command.index]) {
    if (state.status === "playing" || state.status === "loading") {
      await playIndex(command.index);
    } else {
      generation += 1;
      detachAudio();
      await saveState({
        currentIndex: command.index,
        currentTime: 0,
        duration: 0,
        status: "paused",
        statusMessage: `Selected ${chapters[command.index].label}.`,
      });
    }
    return;
  }

  if (command.type === "DOCUSENSE_PLAYER_SEEK" && audio) {
    audio.currentTime = Math.max(0, Math.min(command.time, audio.duration || command.time));
    await saveState({ currentTime: audio.currentTime });
  }
}

chrome.runtime.onMessage.addListener(
  (message: PlayerCommand, _sender, sendResponse: (response: { ok: boolean; error?: string }) => void) => {
    if (message.target !== "offscreen") {
      return false;
    }

    void handleCommand(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "The audio command failed.",
        });
      });
    return true;
  },
);
