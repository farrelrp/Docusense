import {
  ProcessingResult,
  WarningResult,
  checkPdfUploadCache,
  checkPdfUrlCache,
  processPdfUpload,
  processPdfUrl,
} from "./api";
import {
  BackgroundResponse,
  ExtensionMessage,
  PlayerCommand,
  ProcessingCommand,
  SessionWriteCommand,
  StorageGetCommand,
  StorageSetCommand,
} from "./messages";
import { synthesizeWithMicrosoftReadAloud } from "./microsoftReadAloud";
import {
  DEFAULT_PLAYER_STATE,
  PLAYER_STORAGE_KEY,
  PlayerState,
  normalizePlayerState,
} from "./playerStore";
import { ReaderChapter } from "./readerChapters";
import { DEFAULT_SESSION, PersistedSession } from "./sessionStore";

type LastAction =
  | {
      type: "upload";
      file: File;
    }
  | {
      type: "url";
      url: string;
    }
  | null;

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
let lastAction: LastAction = null;
let lastSourceKey = "";
let activeRunId = 0;
const audioUrls = new Map<number, string>();
const pendingAudio = new Map<number, Promise<string>>();
const initialization = readExtensionStorage([
  PLAYER_STORAGE_KEY,
  PLAYER_QUEUE_STORAGE_KEY,
]).then((storageData) => {
  const savedState = normalizePlayerState(storageData[PLAYER_STORAGE_KEY]);
  const queueData = storageData[PLAYER_QUEUE_STORAGE_KEY] as PersistedPlayerQueue | undefined;
  state = savedState.status === "playing" || savedState.status === "loading"
    ? {
        ...savedState,
        status: "paused",
        statusMessage: "Playback is ready to resume.",
      }
    : savedState;
  if (queueData?.documentId === state.documentId) {
    chapters = queueData.chapters;
  }
  return writeExtensionStorage({ [PLAYER_STORAGE_KEY]: state });
});

function isPlayerCommand(message: PlayerCommand | ProcessingCommand): message is PlayerCommand {
  return message.type.startsWith("DOCUSENSE_PLAYER_");
}

function isWarningResult(response: ProcessingResult | WarningResult): response is WarningResult {
  return "status" in response && response.status === "warning";
}

async function readExtensionStorage(keys: string[]): Promise<Record<string, unknown>> {
  const command: StorageGetCommand = {
    type: "DOCUSENSE_STORAGE_GET",
    target: "background",
    keys,
  };
  const response = await chrome.runtime.sendMessage(command) as BackgroundResponse | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "DocuSense could not read extension storage.");
  }
  return response.data ?? {};
}

async function writeExtensionStorage(values: Record<string, unknown>): Promise<void> {
  const command: StorageSetCommand = {
    type: "DOCUSENSE_STORAGE_SET",
    target: "background",
    values,
  };
  const response = await chrome.runtime.sendMessage(command) as BackgroundResponse | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "DocuSense could not update extension storage.");
  }
}

async function writeProcessingSession(session: PersistedSession): Promise<void> {
  const command: SessionWriteCommand = {
    type: "DOCUSENSE_WRITE_SESSION",
    target: "background",
    session,
  };
  const response = await chrome.runtime.sendMessage(command) as BackgroundResponse | undefined;
  if (!response?.ok) {
    throw new Error(response?.error ?? "DocuSense could not update the processing session.");
  }
}

async function runAction(action: LastAction, sourceKey: string, force = false): Promise<void> {
  if (!action) {
    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "error",
      statusMessage: "Processing failed.",
      errorMessage: "DocuSense does not have a saved action to continue.",
    });
    return;
  }

  const runId = ++activeRunId;
  lastAction = action;
  lastSourceKey = sourceKey;
  await writeProcessingSession({
    ...DEFAULT_SESSION,
    sourceKey,
    state: action.type === "upload" ? "uploading" : "checking",
    statusMessage: action.type === "upload" ? "Uploading PDF..." : "Checking PDF URL...",
    startedAt: Date.now(),
  });

  try {
    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "processing",
      statusMessage: "Processing with DocuSense. This may take a minute.",
      startedAt: Date.now(),
    });

    const response =
      action.type === "upload"
        ? await processPdfUpload(action.file, force)
        : await processPdfUrl(action.url, force);

    if (runId !== activeRunId) {
      return;
    }

    if (isWarningResult(response)) {
      await writeProcessingSession({
        ...DEFAULT_SESSION,
        sourceKey,
        state: "warning",
        statusMessage: response.message,
        warning: response,
        startedAt: null,
      });
      return;
    }

    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "completed",
      statusMessage: response.cached
        ? `This PDF was already processed. Showing the saved document for ${response.pageCount} pages.`
        : `Completed. Processed ${response.pageCount} pages.`,
      result: response,
      startedAt: null,
    });
  } catch (error) {
    if (runId !== activeRunId) {
      return;
    }

    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "error",
      statusMessage: "Processing failed.",
      errorMessage: error instanceof Error ? error.message : "DocuSense hit an unknown error.",
      startedAt: null,
    });
  }
}

async function checkCache(action: Exclude<LastAction, null>, sourceKey: string): Promise<void> {
  const runId = ++activeRunId;
  await writeProcessingSession({
    ...DEFAULT_SESSION,
    sourceKey,
    state: "checking",
    statusMessage: "Checking for an existing DocuSense result...",
    startedAt: Date.now(),
  });

  try {
    const response =
      action.type === "upload"
        ? await checkPdfUploadCache(action.file)
        : await checkPdfUrlCache(action.url);
    if (runId !== activeRunId) {
      return;
    }

    if (!("jobId" in response)) {
      await writeProcessingSession({
        ...DEFAULT_SESSION,
        sourceKey,
        statusMessage: "Ready to process this PDF.",
      });
      return;
    }

    lastAction = action;
    lastSourceKey = sourceKey;
    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "completed",
      statusMessage: `This PDF was already processed. Showing the saved document for ${response.pageCount} pages.`,
      result: response,
    });
  } catch (error) {
    if (runId !== activeRunId) {
      return;
    }
    await writeProcessingSession({
      ...DEFAULT_SESSION,
      sourceKey,
      statusMessage: "Ready to process this PDF.",
      errorMessage: error instanceof Error ? error.message : "",
    });
  }
}

function handleProcessingCommand(command: ProcessingCommand): void {
  if (command.type === "DOCUSENSE_START_URL") {
    void runAction(
      { type: "url", url: command.url },
      command.sourceKey,
      Boolean(command.force),
    );
    return;
  }

  if (command.type === "DOCUSENSE_START_UPLOAD") {
    const file = new File([new Uint8Array(command.bytes)], command.fileName, {
      type: command.mimeType || "application/pdf",
    });
    void runAction({ type: "upload", file }, command.sourceKey, Boolean(command.force));
    return;
  }

  if (command.type === "DOCUSENSE_CHECK_URL") {
    void checkCache({ type: "url", url: command.url }, command.sourceKey);
    return;
  }

  if (command.type === "DOCUSENSE_CHECK_UPLOAD") {
    const file = new File([new Uint8Array(command.bytes)], command.fileName, {
      type: command.mimeType || "application/pdf",
    });
    void checkCache({ type: "upload", file }, command.sourceKey);
    return;
  }

  if (command.type === "DOCUSENSE_CONTINUE_LAST") {
    void runAction(lastAction, lastSourceKey, true);
    return;
  }

  lastAction = null;
  lastSourceKey = "";
  activeRunId += 1;
  void writeProcessingSession(DEFAULT_SESSION);
}

async function saveState(patch: Partial<PlayerState>): Promise<void> {
  state = {
    ...state,
    ...patch,
    updatedAt: Date.now(),
  };
  await writeExtensionStorage({ [PLAYER_STORAGE_KEY]: state });
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
    await writeExtensionStorage({
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

  if (command.type === "DOCUSENSE_PLAYER_GENERATE") {
    if (!chapters[state.currentIndex]) {
      throw new Error("No readable sections were found.");
    }

    await saveState({
      status: "loading",
      statusMessage: `Generating ${chapters[state.currentIndex].label}...`,
    });
    try {
      await synthesizeSection(state.currentIndex);
      await saveState({
        status: "paused",
        statusMessage: "Read aloud is ready.",
        currentTime: 0,
        duration: 0,
      });
    } catch (error) {
      await saveState({
        status: "error",
        statusMessage:
          error instanceof Error ? error.message : "Microsoft Read Aloud is unavailable.",
      });
      throw error;
    }
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
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: { ok: boolean; error?: string }) => void,
  ) => {
    if (message.target !== "offscreen") {
      return false;
    }

    if (message.type === "DOCUSENSE_OFFSCREEN_PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (!isPlayerCommand(message)) {
      handleProcessingCommand(message);
      sendResponse({ ok: true });
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
