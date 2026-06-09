import { useEffect, useMemo, useRef, useState } from "react";

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
  const [tabLoaded, setTabLoaded] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [session, setSession] = useState<PersistedSession>({
    ...DEFAULT_SESSION,
    updatedAt: 0,
  });
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [selectedSourceKey, setSelectedSourceKey] = useState("");
  const [showPdfSource, setShowPdfSource] = useState(true);
  const checkedSourceRef = useRef("");

  const isPdfTab = useMemo(() => looksLikePdfUrl(tabInfo.url), [tabInfo.url]);
  const isFileTab = tabInfo.url.toLowerCase().startsWith("file://");
  const tabSourceKey = isPdfTab ? `url:${tabInfo.url}` : "";
  const activeSourceKey = selectedSourceKey || tabSourceKey;
  const visibleSession =
    activeSourceKey && session.sourceKey === activeSourceKey
      ? session
      : { ...DEFAULT_SESSION, sourceKey: activeSourceKey };
  const { state, statusMessage, errorMessage, result, warning } = visibleSession;

  useEffect(() => {
    const chromeApi = globalThis.chrome;
    if (!chromeApi?.tabs?.query) {
      setTabLoaded(true);
      return;
    }

    chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const current = tabs[0];
      setTabInfo({
        url: current?.url ?? "",
        title: current?.title ?? "",
      });
      setTabLoaded(true);
    });
  }, []);

  useEffect(() => {
    let isMounted = true;
    const applySession = (nextSession: PersistedSession) => {
      if (!isMounted) {
        return;
      }
      setSession((current) =>
        nextSession.updatedAt >= current.updatedAt ? nextSession : current,
      );
    };

    readSession()
      .then((savedSession) => {
        applySession(savedSession);
      })
      .catch(() => {
        applySession(DEFAULT_SESSION);
      })
      .finally(() => {
        if (isMounted) {
          setSessionLoaded(true);
        }
      });

    const unsubscribe = subscribeToSessionChanges(applySession);
    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!tabLoaded || !sessionLoaded || !isPdfTab || !tabSourceKey) {
      return;
    }
    if (
      session.sourceKey === tabSourceKey &&
      ["uploading", "processing", "warning"].includes(session.state)
    ) {
      return;
    }
    if (checkedSourceRef.current === tabSourceKey) {
      return;
    }
    checkedSourceRef.current = tabSourceKey;
    setSelectedSourceKey("");

    if (isFileTab) {
      void checkCurrentFileCache(tabInfo.url, tabSourceKey);
      return;
    }
    void sendBackgroundRequest({
      type: "DOCUSENSE_CHECK_URL",
      url: tabInfo.url,
      sourceKey: tabSourceKey,
    });
  }, [
    isFileTab,
    isPdfTab,
    session.state,
    session.sourceKey,
    sessionLoaded,
    tabInfo.url,
    tabLoaded,
    tabSourceKey,
  ]);

  useEffect(() => {
    if (result) {
      setShowPdfSource(false);
    }
  }, [result?.jobId]);

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

  async function sendFileRequest(
    type: "DOCUSENSE_START_UPLOAD" | "DOCUSENSE_CHECK_UPLOAD",
    file: File,
    sourceKey: string,
    force = false,
  ): Promise<boolean> {
    const buffer = await file.arrayBuffer();
    return sendBackgroundRequest({
      type,
      fileName: file.name,
      mimeType: file.type,
      bytes: Array.from(new Uint8Array(buffer)),
      sourceKey,
      ...(type === "DOCUSENSE_START_UPLOAD" ? { force } : {}),
    });
  }

  async function runPendingAction(
    action: PendingAction,
    force = false,
    sourceKeyOverride = "",
  ) {
    if (!action) {
      return;
    }

    setPendingAction(action);
    const sourceKey =
      sourceKeyOverride ||
      (action.type === "upload"
        ? selectedSourceKey || `upload:${action.file.name}:${action.file.size}:${action.file.lastModified}`
        : `url:${action.url}`);
    setSelectedSourceKey(sourceKey);

    const startedInBackground =
      action.type === "upload"
        ? await sendFileRequest("DOCUSENSE_START_UPLOAD", action.file, sourceKey, force)
        : await sendBackgroundRequest({
            type: "DOCUSENSE_START_URL",
            url: action.url,
            sourceKey,
            force,
          });

    if (startedInBackground) {
      return;
    }

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

      if (isWarningResult(response)) {
        await writeSession({
          ...DEFAULT_SESSION,
          sourceKey,
          state: "warning",
          statusMessage: response.message,
          warning: response,
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
      });
    } catch (error) {
      await writeSession({
        ...DEFAULT_SESSION,
        sourceKey,
        state: "error",
        errorMessage: error instanceof Error ? error.message : "DocuSense hit an unknown error.",
        statusMessage: "Processing failed.",
      });
    }
  }

  async function handleProcessCurrentPdf(force = false) {
    setSelectedSourceKey("");
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
      processCurrentFileTab(tabInfo.url, force);
      return;
    }
    runPendingAction({ type: "url", url: tabInfo.url }, force, tabSourceKey);
  }

  async function getCurrentFile(url: string): Promise<File> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`The PDF could not be read from the current tab (${response.status}).`);
    }
    const blob = await response.blob();
    const filename = getFilenameFromUrl(url, "current-tab.pdf");
    return new File([blob], filename, { type: blob.type || "application/pdf" });
  }

  async function checkCurrentFileCache(url: string, sourceKey: string) {
    try {
      const file = await getCurrentFile(url);
      await sendFileRequest("DOCUSENSE_CHECK_UPLOAD", file, sourceKey);
    } catch {
      // File URL access can be disabled; the normal process action reports that explicitly.
    }
  }

  async function processCurrentFileTab(url: string, force = false) {
    const sourceKey = `url:${url}`;
    await writeSession({
      ...DEFAULT_SESSION,
      sourceKey,
      state: "uploading",
      statusMessage: "Reading the current PDF tab...",
      startedAt: Date.now(),
    });

    let file: File;
    try {
      file = await getCurrentFile(url);
    } catch (error) {
      await writeSession({
        ...DEFAULT_SESSION,
        sourceKey,
        state: "error",
        statusMessage: "Processing failed.",
        errorMessage: error instanceof Error
          ? `${error.message} In Edge, open edge://extensions, enable "Allow access to file URLs" for DocuSense, then try again.`
          : "DocuSense could not read the local PDF tab. Enable file URL access for the extension and try again.",
      });
      return;
    }

    try {
      setSelectedSourceKey(sourceKey);
      await runPendingAction({ type: "upload", file }, force, sourceKey);
    } catch (error) {
      await writeSession({
        ...DEFAULT_SESSION,
        sourceKey,
        state: "error",
        statusMessage: "Processing failed.",
        errorMessage:
          error instanceof Error ? error.message : "DocuSense could not start processing.",
      });
    }
  }

  function handleUpload(file: File) {
    const sourceKey = `upload:${file.name}:${file.size}:${file.lastModified}`;
    setSelectedSourceKey(sourceKey);
    runPendingAction({ type: "upload", file }, false, sourceKey);
  }

  function handleContinue() {
    if (!pendingAction) {
      void sendBackgroundRequest({ type: "DOCUSENSE_CONTINUE_LAST" });
      return;
    }

    runPendingAction(pendingAction, true);
  }

  function handleReprocess() {
    if (pendingAction) {
      runPendingAction(pendingAction, true);
      return;
    }
    void handleProcessCurrentPdf(true);
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

      {result ? (
        <ResultPreview
          result={result}
          onOpenFullPage={handleOpenFullPage}
          onReprocess={handleReprocess}
          onShowPdfSource={() => setShowPdfSource((current) => !current)}
          isPdfSourceVisible={showPdfSource}
        />
      ) : null}

      {!result || showPdfSource ? (
        <PdfInputPanel
          currentUrl={tabInfo.url}
          currentTitle={tabInfo.title}
          isPdfTab={isPdfTab}
          isFileTab={isFileTab}
          disabled={state === "uploading" || state === "checking" || state === "processing"}
          onProcessCurrentPdf={() => void handleProcessCurrentPdf()}
          onUpload={handleUpload}
        />
      ) : null}

      {!result ? (
        <ProgressView state={state} message={statusMessage} errorMessage={errorMessage} />
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
