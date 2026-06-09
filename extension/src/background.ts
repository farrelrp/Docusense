import {
  BackgroundRequest,
  BackgroundResponse,
  ExtensionMessage,
  OffscreenPingCommand,
  PlayerCommand,
  ProcessingCommand,
} from "./messages";
import { writeSession } from "./sessionStore";

let creatingOffscreen: Promise<void> | null = null;
const OFFSCREEN_READY_ATTEMPTS = 40;
const OFFSCREEN_READY_DELAY_MS = 50;

function isPlayerCommand(request: BackgroundRequest): request is PlayerCommand {
  return request.type.startsWith("DOCUSENSE_PLAYER_");
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS],
        justification: "Process PDFs and play queued document audio after the popup closes.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForOffscreenDocument(): Promise<void> {
  const ping: OffscreenPingCommand = {
    type: "DOCUSENSE_OFFSCREEN_PING",
    target: "offscreen",
  };

  for (let attempt = 0; attempt < OFFSCREEN_READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(ping) as BackgroundResponse | undefined;
      if (response?.ok) {
        return;
      }
    } catch {
      // createDocument can resolve before the offscreen module registers its listener.
    }
    await delay(OFFSCREEN_READY_DELAY_MS);
  }

  throw new Error("DocuSense could not initialize its background processing document.");
}

async function forwardPlayerCommand(request: PlayerCommand): Promise<BackgroundResponse> {
  return forwardOffscreenCommand(request);
}

async function forwardOffscreenCommand(
  request: PlayerCommand | ProcessingCommand,
): Promise<BackgroundResponse> {
  await ensureOffscreenDocument();
  await waitForOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    ...request,
    target: "offscreen",
  }) as BackgroundResponse | undefined;
  return response ?? { ok: false, error: "The DocuSense offscreen document did not respond." };
}

chrome.runtime.onMessage.addListener(
  (request: ExtensionMessage, _sender, sendResponse: (response: BackgroundResponse) => void) => {
    if (request.type === "DOCUSENSE_WRITE_SESSION") {
      void writeSession(request.session)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "The session update failed.",
          });
        });
      return true;
    }

    if (request.type === "DOCUSENSE_STORAGE_GET") {
      void chrome.storage.local.get(request.keys)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "The storage read failed.",
          });
        });
      return true;
    }

    if (request.type === "DOCUSENSE_STORAGE_SET") {
      void chrome.storage.local.set(request.values)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "The storage update failed.",
          });
        });
      return true;
    }

    if ("target" in request && request.target === "offscreen") {
      return false;
    }

    if (isPlayerCommand(request)) {
      void forwardPlayerCommand(request)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "The audio command failed.",
          });
        });
      return true;
    }

    void forwardOffscreenCommand(request)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "The processing command failed.",
        });
      });
    return true;
  },
);
