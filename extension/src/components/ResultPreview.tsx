import { useCallback, useEffect, useMemo, useState } from "react";

import { ProcessingResult } from "../api";
import { BackgroundResponse, PlayerCommand } from "../messages";
import {
  DEFAULT_PLAYER_STATE,
  PlayerState,
  readPlayerState,
  subscribeToPlayerChanges,
} from "../playerStore";
import { parseChapters } from "../readerChapters";

interface ResultPreviewProps {
  result: ProcessingResult;
  onOpenFullPage: () => void;
  onReprocess: () => void;
  onShowPdfSource: () => void;
  isPdfSourceVisible: boolean;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export default function ResultPreview({
  result,
  onOpenFullPage,
  onReprocess,
  onShowPdfSource,
  isPdfSourceVisible,
}: ResultPreviewProps) {
  const chapters = useMemo(() => parseChapters(result.previewHtml), [result.previewHtml]);
  const [player, setPlayer] = useState<PlayerState>(DEFAULT_PLAYER_STATE);
  const [activeChapterIndex, setActiveChapterIndex] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const activeChapter = chapters[activeChapterIndex] ?? chapters[0];
  const isReadAloudReady =
    player.documentId === result.jobId &&
    player.sections.length > 0 &&
    player.status !== "error";
  const isPlaying = player.status === "playing" || player.status === "loading";

  const sendPlayerCommand = useCallback(async (command: PlayerCommand): Promise<boolean> => {
    try {
      const response = await chrome.runtime.sendMessage(command) as BackgroundResponse | undefined;
      if (response?.ok) {
        return true;
      }
      setPlayer((current) => ({
        ...current,
        status: "error",
        statusMessage: response?.error ?? "The DocuSense player did not respond.",
      }));
      return false;
    } catch (error) {
      setPlayer((current) => ({
        ...current,
        status: "error",
        statusMessage:
          error instanceof Error ? error.message : "The DocuSense player did not respond.",
      }));
      return false;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    readPlayerState().then((savedState) => {
      if (mounted) {
        setPlayer(savedState);
        if (savedState.documentId === result.jobId) {
          setActiveChapterIndex(savedState.currentIndex);
        }
      }
    });
    const unsubscribe = subscribeToPlayerChanges((nextPlayer) => {
      setPlayer(nextPlayer);
      if (nextPlayer.documentId === result.jobId) {
        setActiveChapterIndex(nextPlayer.currentIndex);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [result.jobId]);

  useEffect(() => {
    setActiveChapterIndex(0);
  }, [chapters, result.jobId]);


  const generateReadAloud = useCallback(async (): Promise<void> => {
    const selectedIndex = activeChapterIndex;
    setIsGenerating(true);
    try {
      const loaded = await sendPlayerCommand({
        type: "DOCUSENSE_PLAYER_LOAD",
        documentId: result.jobId,
        chapters,
      });
      if (!loaded) {
        return;
      }
      if (selectedIndex > 0) {
        const selected = await sendPlayerCommand({
          type: "DOCUSENSE_PLAYER_SELECT",
          index: selectedIndex,
        });
        if (!selected) {
          return;
        }
      }
      await sendPlayerCommand({ type: "DOCUSENSE_PLAYER_GENERATE" });
    } finally {
      setIsGenerating(false);
    }
  }, [activeChapterIndex, chapters, result.jobId, sendPlayerCommand]);

  const togglePlayback = useCallback(async (): Promise<void> => {
    if (!isReadAloudReady) {
      await generateReadAloud();
      return;
    }

    await sendPlayerCommand({
      type: isPlaying ? "DOCUSENSE_PLAYER_PAUSE" : "DOCUSENSE_PLAYER_PLAY",
    });
  }, [generateReadAloud, isPlaying, isReadAloudReady, sendPlayerCommand]);

  useEffect(() => {
    const handleGenerateShortcut = () => {
      void generateReadAloud();
    };

    const handleStartShortcut = () => {
      void togglePlayback();
    };

    const handleTogglePlayShortcut = () => {
      void togglePlayback();
    };

    window.addEventListener("docusense:generate-read-aloud", handleGenerateShortcut);
    window.addEventListener("docusense:start-read-aloud", handleStartShortcut);
    window.addEventListener("docusense:toggle-play", handleTogglePlayShortcut);

    return () => {
      window.removeEventListener("docusense:generate-read-aloud", handleGenerateShortcut);
      window.removeEventListener("docusense:start-read-aloud", handleStartShortcut);
      window.removeEventListener("docusense:toggle-play", handleTogglePlayShortcut);
    };
  }, [generateReadAloud, togglePlayback]);

  function selectChapter(index: number): void {
    setActiveChapterIndex(index);
    if (isReadAloudReady) {
      void sendPlayerCommand({
        type: "DOCUSENSE_PLAYER_SELECT",
        index,
      });
    }
  }

  function selectPreviousChapter(): void {
    const previousIndex =
      player.currentTime > 3
        ? activeChapterIndex
        : Math.max(activeChapterIndex - 1, 0);
    setActiveChapterIndex(previousIndex);
    void sendPlayerCommand({ type: "DOCUSENSE_PLAYER_PREVIOUS" });
  }

  function selectNextChapter(): void {
    const nextIndex = Math.min(activeChapterIndex + 1, chapters.length - 1);
    setActiveChapterIndex(nextIndex);
    void sendPlayerCommand({ type: "DOCUSENSE_PLAYER_NEXT" });
  }

  return (
    <section className="panel result-panel" aria-labelledby="result-heading">
      <div className="result-heading-row">
        <div>
          <h2 id="result-heading">Reader</h2>
          <p>{result.pageCount} pages processed</p>
        </div>
        <div className="result-actions">
          <button type="button" className="source-button" onClick={onShowPdfSource}>
            {isPdfSourceVisible ? "Hide Source" : "PDF Source"}
          </button>
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
      {isReadAloudReady && !isGenerating ? (
        <div className="audio-player" aria-label="Document audio player">
          <div className="now-playing">
            <span>Now reading</span>
            <strong>{activeChapter?.label ?? "Document"}</strong>
          </div>

          <div className="transport-controls">
            <button
              type="button"
              className="transport-button"
              aria-label="Previous section"
              title="Previous section"
              disabled={activeChapterIndex <= 0 && player.currentTime <= 3}
              onClick={selectPreviousChapter}
            >
              |&lt;
            </button>
            <button
              type="button"
              className="play-button"
              aria-label={isPlaying ? "Pause" : "Play"}
              disabled={chapters.length === 0}
              onClick={() => void togglePlayback()}
            >
              {player.status === "loading" ? "..." : isPlaying ? "Pause" : "Play"}
            </button>
            <button
              type="button"
              className="transport-button"
              aria-label="Next section"
              title="Next section"
              disabled={activeChapterIndex >= chapters.length - 1}
              onClick={selectNextChapter}
            >
              &gt;|
            </button>
          </div>

          <div className="progress-row">
            <span>{formatTime(player.currentTime)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(player.duration, 1)}
              step="0.1"
              value={Math.min(player.currentTime, Math.max(player.duration, 1))}
              aria-label="Playback position"
              disabled={player.duration <= 0}
              onChange={(event) =>
                void sendPlayerCommand({
                  type: "DOCUSENSE_PLAYER_SEEK",
                  time: Number(event.currentTarget.value),
                })
              }
            />
            <span>{formatTime(player.duration)}</span>
          </div>
          <p className={`player-status status-${player.status}`} aria-live="polite">
            {player.statusMessage}
          </p>
        </div>
      ) : (
        <div className="read-aloud-prompt">
          <button
            type="button"
            className="primary-button"
            disabled={chapters.length === 0 || isGenerating}
            onClick={() => void generateReadAloud()}
          >
            {isGenerating ? "Generating..." : "Generate Read Aloud"}
          </button>
        </div>
      )}

      <div className="reader-layout">
        <nav className="chapter-list" aria-label="Document sections">
          {chapters.map((chapter, index) => (
            <button
              type="button"
              key={chapter.id}
              className={index === activeChapterIndex ? "active" : ""}
              aria-current={index === activeChapterIndex ? "true" : undefined}
              onClick={() => selectChapter(index)}
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
