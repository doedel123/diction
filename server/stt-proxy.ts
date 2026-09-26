import { WebSocket, type RawData } from "ws";
import { Errors } from "../lib/errors";
import {
  buildXaiSttUrl,
  classifyHandshake,
  clientControlMessage,
  readApiKey,
  upstreamHeaders,
} from "../lib/stt-messages";

const MAX_BUFFERED_CHUNKS = 100;
const READY_TIMEOUT_MS = 15_000;

type Pending =
  | { binary: true; data: Buffer }
  | { binary: false; data: string };

export type UpstreamFactory = (url: string, apiKey: string) => WebSocket;

type ProxyOptions = {
  apiKey?: string;
  connectUpstream?: UpstreamFactory;
};

export function handleSttClient(client: WebSocket, options: ProxyOptions = {}): void {
  const apiKey = (options.apiKey ?? readApiKey()).trim();
  if (!apiKey) {
    sendJson(client, {
      type: "error",
      code: "missing_api_key",
      message: Errors.missingApiKey,
    });
    client.close(4001, "missing_api_key");
    return;
  }

  const connect = options.connectUpstream ?? defaultConnect;
  let upstream: WebSocket;
  try {
    upstream = connect(buildXaiSttUrl(), apiKey);
  } catch (error) {
    console.error("[stt] upstream connect failed");
    console.error(error);
    sendJson(client, { type: "error", code: "upstream_error", message: Errors.upstream });
    client.close(1011, "upstream_error");
    return;
  }

  let ready = false;
  let settled = false;
  let clientClosed = false;
  let sentDone = false;
  const pending: Pending[] = [];

  const readyTimer = setTimeout(() => {
    if (!ready) fail("upstream_error", Errors.upstream);
  }, READY_TIMEOUT_MS);
  readyTimer.unref?.();

  const stopTimer = () => clearTimeout(readyTimer);

  function fail(code: string, message: string) {
    if (settled) return;
    settled = true;
    stopTimer();
    sendJson(client, { type: "error", code, message });
    try {
      client.close(1011, code);
    } catch {
      // Socket already gone.
    }
    closeUpstream();
  }

  function closeUpstream() {
    try {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else if (upstream.readyState === WebSocket.OPEN) upstream.close();
    } catch {
      // Ignore close races.
    }
  }

  function flush() {
    if (!ready || upstream.readyState !== WebSocket.OPEN) return;
    while (pending.length > 0) {
      const item = pending.shift();
      if (!item) break;
      upstream.send(item.binary ? item.data : item.data);
    }
  }

  function enqueue(item: Pending) {
    if (settled || clientClosed) return;
    if (!item.binary) noteControl(item.data);
    if (ready && upstream.readyState === WebSocket.OPEN) {
      upstream.send(item.binary ? item.data : item.data);
      return;
    }
    pending.push(item);
    if (pending.length > MAX_BUFFERED_CHUNKS) {
      fail("upstream_error", Errors.upstream);
    }
  }

  upstream.on("message", (data, isBinary) => {
    if (isBinary) {
      if (client.readyState === WebSocket.OPEN) client.send(toBuffer(data));
      return;
    }
    const text = rawToString(data);
    if (client.readyState === WebSocket.OPEN) client.send(text);
    try {
      const event = JSON.parse(text) as { type?: string };
      if (event.type === "transcript.created") {
        ready = true;
        stopTimer();
        flush();
      } else if (event.type === "transcript.done" || event.type === "error") {
        settled = true;
        stopTimer();
      }
    } catch {
      // Non-JSON payloads are still forwarded above.
    }
  });

  upstream.on("unexpected-response", (_request, response) => {
    const status = typeof response.statusCode === "number" ? response.statusCode : null;
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      console.error(`[stt] upstream rejected the handshake (${status ?? "unknown"})`);
      const failure = classifyHandshake(status, body);
      fail(failure.code, failure.message);
    });
  });

  upstream.on("error", (error) => {
    if (settled || clientClosed) return;
    console.error("[stt] upstream error");
    console.error(error instanceof Error ? error.message : error);
    fail("upstream_error", Errors.upstream);
  });

  upstream.on("close", () => {
    stopTimer();
    if (clientClosed || settled) {
      if (!clientClosed && client.readyState === WebSocket.OPEN) {
        try {
          client.close(1000, "closed");
        } catch {
          // Ignore.
        }
      }
      return;
    }
    fail("connection_lost", Errors.connectionLost);
  });

  client.on("message", (data, isBinary) => {
    if (settled || clientClosed) return;
    if (isBinary) {
      enqueue({ binary: true, data: toBuffer(data) });
      return;
    }
    const control = clientControlMessage(rawToString(data));
    if (!control) return;
    enqueue({ binary: false, data: control });
  });

  client.on("close", () => {
    clientClosed = true;
    stopTimer();
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        if (ready && !sentDone) {
          sentDone = true;
          upstream.send(JSON.stringify({ type: "audio.done" }));
        }
      } catch {
        // Upstream already closing.
      }
      closeUpstream();
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      closeUpstream();
    }
  });

  client.on("error", () => {
    clientClosed = true;
    stopTimer();
    closeUpstream();
  });

  function noteControl(data: string) {
    try {
      const type = (JSON.parse(data) as { type?: string }).type;
      if (type === "audio.done") sentDone = true;
    } catch {
      // Control frames are already validated.
    }
  }
}

function defaultConnect(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, {
    headers: upstreamHeaders(apiKey),
    handshakeTimeout: 10_000,
  });
}

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Ignore a closing socket.
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawToString(data: RawData): string {
  return toBuffer(data).toString("utf8");
}
