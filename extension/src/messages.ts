import { ReaderChapter } from "./readerChapters";
import type { PersistedSession } from "./sessionStore";

export type PlayerCommand =
  | {
      type: "DOCUSENSE_PLAYER_LOAD";
      target?: "offscreen";
      documentId: string;
      chapters: ReaderChapter[];
    }
  | {
      type: "DOCUSENSE_PLAYER_PLAY";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_PLAYER_GENERATE";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_PLAYER_PAUSE";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_PLAYER_NEXT";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_PLAYER_PREVIOUS";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_PLAYER_SELECT";
      target?: "offscreen";
      index: number;
    }
  | {
      type: "DOCUSENSE_PLAYER_SEEK";
      target?: "offscreen";
      time: number;
    };

export type ProcessingCommand =
  | {
      type: "DOCUSENSE_START_URL";
      target?: "offscreen";
      url: string;
      sourceKey: string;
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_START_UPLOAD";
      target?: "offscreen";
      fileName: string;
      mimeType: string;
      bytes: number[];
      sourceKey: string;
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_CHECK_URL";
      target?: "offscreen";
      url: string;
      sourceKey: string;
    }
  | {
      type: "DOCUSENSE_CHECK_UPLOAD";
      target?: "offscreen";
      fileName: string;
      mimeType: string;
      bytes: number[];
      sourceKey: string;
    }
  | {
      type: "DOCUSENSE_CONTINUE_LAST";
      target?: "offscreen";
    }
  | {
      type: "DOCUSENSE_RESET_SESSION";
      target?: "offscreen";
    };

export type BackgroundRequest = ProcessingCommand | PlayerCommand;

export interface SessionWriteCommand {
  type: "DOCUSENSE_WRITE_SESSION";
  target: "background";
  session: PersistedSession;
}

export interface StorageGetCommand {
  type: "DOCUSENSE_STORAGE_GET";
  target: "background";
  keys: string[];
}

export interface StorageSetCommand {
  type: "DOCUSENSE_STORAGE_SET";
  target: "background";
  values: Record<string, unknown>;
}

export interface OffscreenPingCommand {
  type: "DOCUSENSE_OFFSCREEN_PING";
  target: "offscreen";
}

export type ExtensionMessage =
  | BackgroundRequest
  | SessionWriteCommand
  | StorageGetCommand
  | StorageSetCommand
  | OffscreenPingCommand;

export interface BackgroundResponse {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}
