const BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "130.0.2849.68";
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600;
const S_TO_NS = 1e9;
const MAX_CHUNK_BYTES = 4096;

export interface MicrosoftReadAloudOptions {
  voiceName?: string;
  rate?: string;
  signal?: AbortSignal;
}

interface HeaderParseResult {
  headers: Record<string, string>;
  data: Uint8Array;
}

function createConnectionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function dateToString(): string {
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

async function generateSecMsGec(): Promise<string> {
  let ticks = Date.now() / 1000;
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;

  const data = new TextEncoder().encode(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function makeSsml(text: string, voiceName: string, rate: string): string {
  return [
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>",
    `<voice name='${voiceName}'>`,
    `<prosody pitch='+0Hz' rate='${rate}' volume='+0%'>`,
    escapeXml(text),
    "</prosody>",
    "</voice>",
    "</speak>",
  ].join("");
}

function ssmlMessage(requestId: string, ssml: string): string {
  return [
    `X-RequestId:${requestId}`,
    "Content-Type:application/ssml+xml",
    `X-Timestamp:${dateToString()}Z`,
    "Path:ssml",
    "",
    ssml,
  ].join("\r\n");
}

function parseTextMessage(message: string): HeaderParseResult {
  const separatorIndex = message.indexOf("\r\n\r\n");
  const headerText = separatorIndex >= 0 ? message.slice(0, separatorIndex) : message;
  const bodyText = separatorIndex >= 0 ? message.slice(separatorIndex + 4) : "";
  return {
    headers: Object.fromEntries(
      headerText
        .split("\r\n")
        .map((line) => line.split(/:(.*)/s).slice(0, 2))
        .filter(([key, value]) => key && value)
        .map(([key, value]) => [key, value.trim()]),
    ),
    data: new TextEncoder().encode(bodyText),
  };
}

function parseBinaryMessage(message: ArrayBuffer): HeaderParseResult {
  const bytes = new Uint8Array(message);
  if (bytes.length < 2) {
    throw new Error("Microsoft Read Aloud returned an invalid audio frame.");
  }

  const headerLength = (bytes[0] << 8) | bytes[1];
  const headerBytes = bytes.slice(2, headerLength + 2);
  const headerText = new TextDecoder().decode(headerBytes);

  return {
    headers: Object.fromEntries(
      headerText
        .split("\r\n")
        .map((line) => line.split(/:(.*)/s).slice(0, 2))
        .filter(([key, value]) => key && value)
        .map(([key, value]) => [key, value.trim()]),
    ),
    data: bytes.slice(headerLength + 2),
  };
}

function splitText(text: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let remaining = text.replace(/\s+/g, " ").trim();

  while (encoder.encode(remaining).length > MAX_CHUNK_BYTES) {
    let splitAt = Math.min(remaining.length, MAX_CHUNK_BYTES);
    while (encoder.encode(remaining.slice(0, splitAt)).length > MAX_CHUNK_BYTES) {
      splitAt -= 1;
    }

    const lastSentence = Math.max(
      remaining.lastIndexOf(". ", splitAt),
      remaining.lastIndexOf("? ", splitAt),
      remaining.lastIndexOf("! ", splitAt),
    );
    const lastSpace = remaining.lastIndexOf(" ", splitAt);
    const boundary = lastSentence > 300 ? lastSentence + 1 : Math.max(lastSpace, splitAt);

    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function synthesizeChunk(
  text: string,
  voiceName: string,
  rate: string,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  const secMsGec = await generateSecMsGec();
  const connectionId = createConnectionId();
  const url =
    `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const websocket = new WebSocket(url);
    websocket.binaryType = "arraybuffer";

    const abort = () => {
      websocket.close();
      reject(new DOMException("Microsoft Read Aloud playback was stopped.", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });

    websocket.onopen = () => {
      websocket.send(
        [
          `X-Timestamp:${dateToString()}`,
          "Content-Type:application/json; charset=utf-8",
          "Path:speech.config",
          "",
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}',
          "",
        ].join("\r\n"),
      );
      websocket.send(ssmlMessage(createConnectionId(), makeSsml(text, voiceName, rate)));
    };

    websocket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      try {
        if (typeof event.data === "string") {
          const { headers } = parseTextMessage(event.data);
          if (headers.Path === "turn.end") {
            websocket.close();
          }
          return;
        }

        const { headers, data } = parseBinaryMessage(event.data);
        if (headers.Path === "audio" && data.length > 0) {
          chunks.push(data);
        }
      } catch (error) {
        websocket.close();
        reject(error);
      }
    };

    websocket.onerror = () => {
      reject(new Error("Microsoft Read Aloud could not connect."));
    };

    websocket.onclose = () => {
      signal?.removeEventListener("abort", abort);
      if (chunks.length === 0) {
        reject(new Error("Microsoft Read Aloud did not return audio."));
        return;
      }
      resolve(chunks);
    };
  });
}

export async function synthesizeWithMicrosoftReadAloud(
  text: string,
  options: MicrosoftReadAloudOptions = {},
): Promise<string> {
  const voiceName = options.voiceName ?? "en-US-JennyNeural";
  const rate = options.rate ?? "+0%";
  const audioChunks: Uint8Array[] = [];

  for (const chunk of splitText(text)) {
    if (options.signal?.aborted) {
      throw new DOMException("Microsoft Read Aloud playback was stopped.", "AbortError");
    }
    audioChunks.push(...await synthesizeChunk(chunk, voiceName, rate, options.signal));
  }

  const blobParts = audioChunks.map((chunk) => chunk.slice().buffer as ArrayBuffer);
  return URL.createObjectURL(new Blob(blobParts, { type: "audio/mpeg" }));
}
