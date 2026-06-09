import { ReaderChapter } from "./readerChapters";

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

export type BackgroundRequest =
  | {
      type: "DOCUSENSE_START_URL";
      url: string;
      sourceKey: string;
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_START_UPLOAD";
      fileName: string;
      mimeType: string;
      bytes: number[];
      sourceKey: string;
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_CHECK_URL";
      url: string;
      sourceKey: string;
    }
  | {
      type: "DOCUSENSE_CHECK_UPLOAD";
      fileName: string;
      mimeType: string;
      bytes: number[];
      sourceKey: string;
    }
  | {
      type: "DOCUSENSE_CONTINUE_LAST";
    }
  | {
      type: "DOCUSENSE_RESET_SESSION";
    }
  | PlayerCommand;

export interface BackgroundResponse {
  ok: boolean;
  error?: string;
}
