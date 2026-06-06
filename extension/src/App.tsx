import { useEffect, useMemo, useState } from "react";

import {
  JobState,
  ProcessingResult,
  WarningResult,
  processPdfUpload,
  processPdfUrl,
} from "./api";
import { BackgroundRequest, BackgroundResponse } from "./messages";
import {
  DEFAULT_SESSION,
  PersistedSession,
  readSession,
  subscribeToSessionChanges,
  writeSession,
} from "./sessionStore";
import Header from "./components/Header";
import PdfInputPanel from "./components/PdfInputPanel";
import ProgressView from "./components/ProgressView";
import ResultPreview from "./components/ResultPreview";
import WarningModal from "./components/WarningModal";

type PendingAction =
  | { type: "upload"; file: File }
  | { type: "url"; url: string }
  | null;

interface TabInfo {
  url: string;
  title: string;
}

function looksLikePdfUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes(".pdf") || lowerUrl.startsWith("file://");
}

function isWarningResult(response: ProcessingResult | WarningResult): response is WarningResult {
  return "status" in response && response.status === "warning";
}

function getFilenameFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const filename = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "");
    return filename.toLowerCase().endsWith(".pdf") ? filename : fallback;
  } catch {
    return fallback;
  }
}

export default function App() {
  const [tabInfo, setTabInfo] = useState<TabInfo>({ url: "", title: "" });
  const [session, setSession] = useState<PersistedSession>(DEFAULT_SESSION);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const isPdfTab = useMemo(() => looksLikePdfUrl(tabInfo.url), [tabInfo.url]);
  const isFileTab = tabInfo.url.toLowerCase().startsWith("file://");
  const { state, statusMessage, errorMessage, result, warning } = session;

  useEffect(() => {
    const chromeApi = globalThis.chrome;
    if (!chromeApi?.tabs?.query) {
      return;
    }

    chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const current = tabs[0];
      setTabInfo({
        url: current?.url ?? "",
        title: current?.title ?? "",
      });
    });
  }, []);

  useEffect(() => {
    let isMounted = true;

    readSession()
      .then((savedSession) => {
        if (isMounted) {
          setSession(savedSession);
        }
      })
      .catch(() => {
        if (isMounted) {
          setSession(DEFAULT_SESSION);
        }
      });

    const unsubscribe = subscribeToSessionChanges(setSession);
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  async function sendBackgroundRequest(request: BackgroundRequest): Promise<boolean> {
    const chromeApi = globalThis.chrome;
    if (!chromeApi?.runtime?.sendMessage) {
      return false;
    }

    const response = await chromeApi.runtime.sendMessage(request) as BackgroundResponse | undefined;
    if (response?.ok) {
      return true;
    }

    throw new Error(response?.error ?? "DocuSense could not start background processing.");
  }

  async function startUploadInBackground(file: File, force = false): Promise<boolean> {
    const buffer = await file.arrayBuffer();
    return sendBackgroundRequest({
      type: "DOCUSENSE_START_UPLOAD",
      fileName: file.name,
      mimeType: file.type,
      bytes: Array.from(new Uint8Array(buffer)),
      force,
    });
  }

  async function runPendingAction(action: PendingAction, force = false) {
    if (!action) {
      return;
    }

    setPendingAction(action);

    const startedInBackground =
      action.type === "upload"
        ? await startUploadInBackground(action.file, force)
        : await sendBackgroundRequest({ type: "DOCUSENSE_START_URL", url: action.url, force });

    if (startedInBackground) {
      return;
    }

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

      if (isWarningResult(response)) {
        await writeSession({
          ...DEFAULT_SESSION,
          state: "warning",
          statusMessage: response.message,
          warning: response,
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
      });
    } catch (error) {
      await writeSession({
        ...DEFAULT_SESSION,
        state: "error",
        errorMessage: error instanceof Error ? error.message : "DocuSense hit an unknown error.",
        statusMessage: "Processing failed.",
      });
    }
  }

  function handleProcessCurrentPdf() {
    if (!tabInfo.url) {
      void writeSession({
        ...DEFAULT_SESSION,
        state: "error",
        statusMessage: "Processing failed.",
        errorMessage: "DocuSense could not read the current tab URL.",
      });
      return;
    }
    if (isFileTab) {
      processCurrentFileTab(tabInfo.url);
      return;
    }
    runPendingAction({ type: "url", url: tabInfo.url });
  }

  async function processCurrentFileTab(url: string) {
    await writeSession({
      ...DEFAULT_SESSION,
      state: "uploading",
      statusMessage: "Reading the current PDF tab...",
      startedAt: Date.now(),
    });

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`The PDF could not be read from the current tab (${response.status}).`);
      }

      const blob = await response.blob();
      const filename = getFilenameFromUrl(url, "current-tab.pdf");
      const file = new File([blob], filename, { type: blob.type || "application/pdf" });
      await runPendingAction({ type: "upload", file });
    } catch (error) {
      await writeSession({
        ...DEFAULT_SESSION,
        state: "error",
        statusMessage: "Processing failed.",
        errorMessage: error instanceof Error
          ? `${error.message} In Edge, open edge://extensions, enable "Allow access to file URLs" for DocuSense, then try again.`
          : "DocuSense could not read the local PDF tab. Enable file URL access for the extension and try again.",
      });
    }
  }

  function handleUpload(file: File) {
    runPendingAction({ type: "upload", file });
  }

  function handleContinue() {
    if (!pendingAction) {
      void sendBackgroundRequest({ type: "DOCUSENSE_CONTINUE_LAST" });
      return;
    }

    runPendingAction(pendingAction, true);
  }

  function handleReprocess() {
    runPendingAction(pendingAction, true);
  }

  function handleOpenFullPage() {
    if (!result) {
      return;
    }

    const chromeApi = globalThis.chrome;
    if (chromeApi?.tabs?.create) {
      chromeApi.tabs.create({ url: result.resultUrl });
      return;
    }
    window.open(result.resultUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="app-shell">
      <Header />
      <PdfInputPanel
        currentUrl={tabInfo.url}
        currentTitle={tabInfo.title}
        isPdfTab={isPdfTab}
        isFileTab={isFileTab}
        disabled={state === "uploading" || state === "checking" || state === "processing"}
        onProcessCurrentPdf={handleProcessCurrentPdf}
        onUpload={handleUpload}
      />

      <ProgressView state={state} message={statusMessage} errorMessage={errorMessage} />

      {result ? (
        <ResultPreview
          result={result}
          onOpenFullPage={handleOpenFullPage}
          onReprocess={handleReprocess}
        />
      ) : null}

      {warning ? (
        <WarningModal
          warning={warning}
          onCancel={() => {
            setPendingAction(null);
            void sendBackgroundRequest({ type: "DOCUSENSE_RESET_SESSION" }).then((sent) => {
              if (!sent) {
                return writeSession(DEFAULT_SESSION);
              }
              return undefined;
            });
          }}
          onContinue={handleContinue}
        />
      ) : null}
    </main>
  );
}
