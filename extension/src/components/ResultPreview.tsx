import { useEffect, useMemo, useRef, useState } from "react";

import { ProcessingResult } from "../api";

interface ResultPreviewProps {
  result: ProcessingResult;
  onOpenFullPage: () => void;
  onReprocess: () => void;
}

interface ReaderChapter {
  id: string;
  label: string;
  html: string;
  text: string;
}

function getReadableHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
    .forEach((node) => node.remove());
  return clone.innerHTML.trim();
}

function getReadableText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
    .forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function getHeadingText(element: Element, fallback: string): string {
  return (
    element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4")?.textContent
      ?.replace(/\s+/g, " ")
      .trim() || fallback
  );
}

function parseChapters(html: string): ReaderChapter[] {
  const documentHtml = new DOMParser().parseFromString(html, "text/html");
  const article =
    documentHtml.querySelector("main article") ??
    documentHtml.querySelector("article") ??
    documentHtml.body;
  const chapters: ReaderChapter[] = [];

  const documentInfoNodes = Array.from(article.children).filter((child) => {
    if (child.matches("[data-read-aloud-ui='true'], nav, section, script, style")) {
      return false;
    }
    return Boolean(getReadableText(child));
  });

  if (documentInfoNodes.length > 0) {
    const htmlFragment = documentInfoNodes
      .map((node) => {
        const clone = node.cloneNode(true) as Element;
        clone
          .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
          .forEach((child) => child.remove());
        return clone.outerHTML;
      })
      .join("");
    const text = documentInfoNodes.map((node) => getReadableText(node)).filter(Boolean).join(". ");
    chapters.push({
      id: "document-information",
      label: "Document Information",
      html: htmlFragment,
      text,
    });
  }

  Array.from(article.querySelectorAll(":scope > section")).forEach((section, index) => {
    const text = getReadableText(section);
    if (!text) {
      return;
    }

    chapters.push({
      id: section.id || `chapter-${index + 1}`,
      label: getHeadingText(section, `Chapter ${index + 1}`),
      html: getReadableHtml(section),
      text,
    });
  });

  if (chapters.length === 0) {
    const text = getReadableText(article);
    chapters.push({
      id: "document",
      label: "Document",
      html: getReadableHtml(article),
      text,
    });
  }

  return chapters;
}

export default function ResultPreview({
  result,
  onOpenFullPage,
  onReprocess,
}: ResultPreviewProps) {
  const chapters = useMemo(() => parseChapters(result.previewHtml), [result.previewHtml]);
  const [activeChapterId, setActiveChapterId] = useState(chapters[0]?.id ?? "");
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("Ready to read.");
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const activeChapter = chapters.find((chapter) => chapter.id === activeChapterId) ?? chapters[0];

  useEffect(() => {
    setActiveChapterId(chapters[0]?.id ?? "");
    stopReading("Ready to read.");
    return () => {
      globalThis.speechSynthesis?.cancel();
    };
  }, [chapters]);

  function stopReading(nextStatus = "Reading stopped.") {
    globalThis.speechSynthesis?.cancel();
    utteranceRef.current = null;
    setIsPlaying(false);
    setStatus(nextStatus);
  }

  function readChapter(chapter = activeChapter) {
    if (!chapter?.text) {
      setStatus("No readable text was found for this chapter.");
      return;
    }
    if (!globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
      setStatus("This browser does not support read aloud controls.");
      return;
    }

    globalThis.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(chapter.text);
    utterance.lang = document.documentElement.lang || "en";
    utterance.onstart = () => {
      setIsPlaying(true);
      setStatus(`Reading ${chapter.label}.`);
    };
    utterance.onend = () => {
      utteranceRef.current = null;
      setIsPlaying(false);
      setStatus("Ready to read.");
    };
    utterance.onerror = () => {
      utteranceRef.current = null;
      setIsPlaying(false);
      setStatus("Read aloud stopped before finishing.");
    };
    utteranceRef.current = utterance;
    globalThis.speechSynthesis.speak(utterance);
  }

  function handleChapterSelect(chapter: ReaderChapter) {
    setActiveChapterId(chapter.id);
    if (isPlaying) {
      readChapter(chapter);
      return;
    }
    setStatus(`Selected ${chapter.label}.`);
  }

  return (
    <section className="panel result-panel" aria-labelledby="result-heading">
      <div className="result-heading-row">
        <div>
          <h2 id="result-heading">Reader</h2>
          <p>{result.pageCount} pages processed</p>
        </div>
        <div className="result-actions">
          <button type="button" className="secondary-button compact" onClick={onOpenFullPage}>
            Open HTML
          </button>
          {result.cached ? (
            <button type="button" className="secondary-button compact" onClick={onReprocess}>
              Re-process
            </button>
          ) : null}
        </div>
      </div>
      {result.cached ? (
        <p className="cache-note">
          This URL has already been processed. DocuSense is showing the saved document.
        </p>
      ) : null}

      <div className="reader-controls" aria-label="Read aloud controls">
        <button
          type="button"
          className="primary-button compact"
          onClick={() => readChapter()}
          disabled={isPlaying}
        >
          Play
        </button>
        <button
          type="button"
          className="secondary-button compact"
          onClick={() => stopReading()}
          disabled={!isPlaying}
        >
          Stop
        </button>
        <p aria-live="polite">{status}</p>
      </div>

      <div className="reader-layout">
        <nav className="chapter-list" aria-label="Document chapters">
          {chapters.map((chapter) => (
            <button
              type="button"
              key={chapter.id}
              className={chapter.id === activeChapter?.id ? "active" : ""}
              onClick={() => handleChapterSelect(chapter)}
            >
              {chapter.label}
            </button>
          ))}
        </nav>

        {activeChapter ? (
          <article
            className="chapter-content"
            tabIndex={0}
            aria-label={activeChapter.label}
            dangerouslySetInnerHTML={{ __html: activeChapter.html }}
          />
        ) : null}
      </div>
    </section>
  );
}
