export type BackgroundRequest =
  | {
      type: "DOCUSENSE_START_URL";
      url: string;
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_START_UPLOAD";
      fileName: string;
      mimeType: string;
      bytes: number[];
      force?: boolean;
    }
  | {
      type: "DOCUSENSE_CONTINUE_LAST";
    }
  | {
      type: "DOCUSENSE_RESET_SESSION";
    };

export interface BackgroundResponse {
  ok: boolean;
  error?: string;
}
