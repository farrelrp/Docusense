import {
  ProcessingResult,
  WarningResult,
  checkPdfUploadCache,
  checkPdfUrlCache,
  processPdfUpload,
  processPdfUrl,
} from "./api";
import { BackgroundRequest, BackgroundResponse, PlayerCommand } from "./messages";
import { DEFAULT_SESSION, writeSession } from "./sessionStore";

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

let lastAction: LastAction = null;
let lastSourceKey = "";
let activeRunId = 0;
let creatingOffscreen: Promise<void> | null = null;

function isPlayerCommand(request: BackgroundRequest): request is PlayerCommand {
  return request.type.startsWith("DOCUSENSE_PLAYER_");
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
        justification: "Synthesize and play queued document sections after the player window closes.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function forwardPlayerCommand(request: PlayerCommand): Promise<BackgroundResponse> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    ...request,
    target: "offscreen",
  }) as BackgroundResponse | undefined;
  return response ?? { ok: false, error: "The DocuSense audio player did not respond." };
}

function isWarningResult(response: ProcessingResult | WarningResult): response is WarningResult {
  return "status" in response && response.status === "warning";
}

async function runAction(action: LastAction, sourceKey: string, force = false): Promise<void> {
  if (!action) {
    await writeSession({
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
  await writeSession({
    ...DEFAULT_SESSION,
    sourceKey,
    state: action.type === "upload" ? "uploading" : "checking",
    statusMessage: action.type === "upload" ? "Uploading PDF..." : "Checking PDF URL...",
    startedAt: Date.now(),
  });

  try {
    await writeSession({
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
      await writeSession({
        ...DEFAULT_SESSION,
        sourceKey,
        state: "warning",
        statusMessage: response.message,
        warning: response,
        startedAt: null,
      });
      return;
    }

    await writeSession({
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

    await writeSession({
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
  await writeSession({
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
      await writeSession({
        ...DEFAULT_SESSION,
        sourceKey,
        statusMessage: "Ready to process this PDF.",
      });
      return;
    }

    lastAction = action;
    lastSourceKey = sourceKey;
    await writeSession({
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
    await writeSession({
      ...DEFAULT_SESSION,
      sourceKey,
      statusMessage: "Ready to process this PDF.",
      errorMessage: error instanceof Error ? error.message : "",
    });
  }
}

chrome.runtime.onMessage.addListener(
  (request: BackgroundRequest, _sender, sendResponse: (response: BackgroundResponse) => void) => {
    if ("target" in request && request.target === "offscreen") {
      return false;
    }

    if (isPlayerCommand(request)) {
      void forwardPlayerCommand(request)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "The audio command failed.",
          });
        });
      return true;
    }

    if (request.type === "DOCUSENSE_START_URL") {
      void runAction(
        { type: "url", url: request.url },
        request.sourceKey,
        Boolean(request.force),
      );
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_START_UPLOAD") {
      const file = new File([new Uint8Array(request.bytes)], request.fileName, {
        type: request.mimeType || "application/pdf",
      });
      void runAction({ type: "upload", file }, request.sourceKey, Boolean(request.force));
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_CHECK_URL") {
      void checkCache({ type: "url", url: request.url }, request.sourceKey);
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_CHECK_UPLOAD") {
      const file = new File([new Uint8Array(request.bytes)], request.fileName, {
        type: request.mimeType || "application/pdf",
      });
      void checkCache({ type: "upload", file }, request.sourceKey);
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_CONTINUE_LAST") {
      void runAction(lastAction, lastSourceKey, true);
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_RESET_SESSION") {
      lastAction = null;
      lastSourceKey = "";
      activeRunId += 1;
      void writeSession(DEFAULT_SESSION);
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: "Unknown DocuSense background request." });
    return false;
  },
);
