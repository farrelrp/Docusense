import { ProcessingResult, WarningResult, processPdfUpload, processPdfUrl } from "./api";
import { BackgroundRequest, BackgroundResponse } from "./messages";
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
let activeRunId = 0;

function isWarningResult(response: ProcessingResult | WarningResult): response is WarningResult {
  return "status" in response && response.status === "warning";
}

async function runAction(action: LastAction, force = false): Promise<void> {
  if (!action) {
    await writeSession({
      ...DEFAULT_SESSION,
      state: "error",
      statusMessage: "Processing failed.",
      errorMessage: "DocuSense does not have a saved action to continue.",
    });
    return;
  }

  const runId = ++activeRunId;
  lastAction = action;
  await writeSession({
    ...DEFAULT_SESSION,
    state: action.type === "upload" ? "uploading" : "checking",
    statusMessage: action.type === "upload" ? "Uploading PDF..." : "Checking PDF URL...",
    startedAt: Date.now(),
  });

  try {
    await writeSession({
      ...DEFAULT_SESSION,
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
        state: "warning",
        statusMessage: response.message,
        warning: response,
        startedAt: null,
      });
      return;
    }

    await writeSession({
      ...DEFAULT_SESSION,
      state: "completed",
      statusMessage: response.cached
        ? `This URL was already processed. Showing the saved document for ${response.pageCount} pages.`
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
      state: "error",
      statusMessage: "Processing failed.",
      errorMessage: error instanceof Error ? error.message : "DocuSense hit an unknown error.",
      startedAt: null,
    });
  }
}

chrome.runtime.onMessage.addListener(
  (request: BackgroundRequest, _sender, sendResponse: (response: BackgroundResponse) => void) => {
    if (request.type === "DOCUSENSE_START_URL") {
      void runAction({ type: "url", url: request.url }, Boolean(request.force));
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_START_UPLOAD") {
      const file = new File([new Uint8Array(request.bytes)], request.fileName, {
        type: request.mimeType || "application/pdf",
      });
      void runAction({ type: "upload", file }, Boolean(request.force));
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_CONTINUE_LAST") {
      void runAction(lastAction, true);
      sendResponse({ ok: true });
      return false;
    }

    if (request.type === "DOCUSENSE_RESET_SESSION") {
      lastAction = null;
      activeRunId += 1;
      void writeSession(DEFAULT_SESSION);
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: "Unknown DocuSense background request." });
    return false;
  },
);
