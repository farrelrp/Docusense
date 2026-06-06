interface PdfInputPanelProps {
  currentUrl: string;
  currentTitle: string;
  isPdfTab: boolean;
  isFileTab: boolean;
  disabled: boolean;
  onProcessCurrentPdf: () => void;
  onUpload: (file: File) => void;
}

export default function PdfInputPanel({
  currentUrl,
  currentTitle,
  isPdfTab,
  isFileTab,
  disabled,
  onProcessCurrentPdf,
  onUpload,
}: PdfInputPanelProps) {
  return (
    <section className="panel" aria-labelledby="pdf-source-heading">
      <h2 id="pdf-source-heading">PDF source</h2>

      <div className="current-tab">
        <p className="label">Current tab</p>
        <p className="tab-title">{currentTitle || "No active tab detected"}</p>
        <p className="tab-url">{currentUrl || "Open an online PDF tab or upload a local file."}</p>
        <p className="tab-status">
          {isFileTab
            ? "Local PDF detected. File URL access must be enabled in Edge."
            : isPdfTab
              ? "PDF detected."
              : "No PDF URL detected."}
        </p>
        <button
          type="button"
          className="primary-button"
          onClick={onProcessCurrentPdf}
          disabled={disabled || !isPdfTab}
        >
          Process Current PDF
        </button>
      </div>

      <div className="divider" role="separator">
        or upload a local file
      </div>

      <label className="file-control">
        <span>Upload PDF</span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              onUpload(file);
            }
            event.currentTarget.value = "";
          }}
        />
      </label>
    </section>
  );
}
