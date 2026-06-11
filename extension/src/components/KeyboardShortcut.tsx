import { useEffect } from "react";

interface KeyboardShortcutProps {
  onProcessCurrentPdf: () => void;
}

export default function KeyboardShortcut({ onProcessCurrentPdf }: KeyboardShortcutProps) {
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      const isCommandKey = event.ctrlKey || event.metaKey;

      if (isCommandKey && event.key === "Enter") {
        event.preventDefault();
        onProcessCurrentPdf();
        return;
      }

      if (isCommandKey && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("docusense:generate-read-aloud"));
        return;
      }

      if (isCommandKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("docusense:toggle-play"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onProcessCurrentPdf]);

  return null;
}
