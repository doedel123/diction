import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import test from "node:test";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Errors } from "../lib/errors";
import { handleSttClient } from "../server/stt-proxy";

type Frame = { binary: boolean; data: Buffer };

function framesOf(socket: WebSocket): Frame[] {
  const frames: Frame[] = [];
  socket.on("message", (data, isBinary) => {
    frames.push({ binary: isBinary, data: toBuffer(data) });
  });
  return frames;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function waitFor(check: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > 2000) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

async function listenWs(): Promise<{ server: WebSocketServer; port: number }> {
  const server = await new Promise<WebSocketServer>((resolve, reject) => {
    let created: WebSocketServer;
    created = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve(created));
    created.once("error", (error) => reject(error));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WebSocket-Server ohne Port");
  return { server, port: address.port };
}

async function listenHttp(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

test("missing API key closes the browser socket without dialing xAI", async () => {
  let dialed = false;
  const { server: browserServer, port } = await listenWs();
  browserServer.on("connection", (socket) => {
    handleSttClient(socket, {
      apiKey: "   ",
      connectUpstream: () => {
        dialed = true;
        throw new Error("should not connect");
      },
    });
  });
  const browser = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = framesOf(browser);
  await new Promise<void>((resolve) => browser.once("close", () => resolve()));
  assert.equal(dialed, false);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.binary, false);
  const payload = JSON.parse(frames[0]!.data.toString()) as { code?: string; message?: string };
  assert.equal(payload.code, "missing_api_key");
  assert.equal(payload.message, Errors.missingApiKey);
  await new Promise<void>((resolve) => browserServer.close(() => resolve()));
});

test("audio is forwarded only after transcript.created, and unknown JSON is dropped", async () => {
  const { server: upstreamServer, port: upstreamPort } = await listenWs();
  const upstreamReady = new Promise<WebSocket>((resolve) => {
    upstreamServer.once("connection", resolve);
  });

  const { server: browserServer, port: browserPort } = await listenWs();
  browserServer.on("connection", (socket) => {
    handleSttClient(socket, {
      apiKey: "test-key",
      connectUpstream: (url, apiKey) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("model"), "grok-voice-transcribe-2.0");
        assert.equal(parsed.searchParams.get("language"), "de");
        assert.equal(apiKey, "test-key");
        return new WebSocket(`ws://127.0.0.1:${upstreamPort}`);
      },
    });
  });
  const browser = new WebSocket(`ws://127.0.0.1:${browserPort}`);
  await new Promise<void>((resolve) => browser.once("open", () => resolve()));
  const browserFrames = framesOf(browser);
  const upstream = await upstreamReady;
  const upstreamFrames = framesOf(upstream);

  const audio = Buffer.from([1, 2, 3, 4]);
  browser.send(audio);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(upstreamFrames.length, 0);

  upstream.send(JSON.stringify({ type: "transcript.created" }));
  await waitFor(() => upstreamFrames.some((frame) => frame.binary));
  assert.deepEqual(upstreamFrames[0]?.data, audio);

  browser.send(JSON.stringify({ type: "session.update", evil: true }));
  browser.send(JSON.stringify({ type: "Finalize", channel: 3 }));
  await waitFor(() => upstreamFrames.some((frame) => !frame.binary));
  const control = upstreamFrames.filter((frame) => !frame.binary).map((frame) => frame.data.toString());
  assert.deepEqual(control, ['{"type":"finalize"}']);

  upstream.send(
    JSON.stringify({
      type: "transcript.partial",
      text: "Hallo",
      is_final: false,
      start: 0,
    }),
  );
  await waitFor(() => browserFrames.some((frame) => frame.data.toString().includes("Hallo")));

  browser.send(JSON.stringify({ type: "audio.done" }));
  await waitFor(() =>
    upstreamFrames.some((frame) => frame.data.toString() === '{"type":"audio.done"}'),
  );

  upstream.send(JSON.stringify({ type: "transcript.done", text: "Hallo.", duration: 1 }));
  upstream.close();
  await waitFor(() => browserFrames.some((frame) => frame.data.toString().includes("transcript.done")));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const errors = browserFrames
    .map((frame) => frame.data.toString())
    .filter((text) => text.includes("connection_lost"));
  assert.deepEqual(errors, []);

  browser.close();
  await new Promise<void>((resolve) => browserServer.close(() => resolve()));
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

test("a rejected upstream handshake reports an unauthorized key", async () => {
  const httpServer = createServer((_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code: "Client specified an invalid argument",
        error: "Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
      }),
    );
  });
  const httpPort = await listenHttp(httpServer);

  const { server: browserServer, port } = await listenWs();
  browserServer.on("connection", (socket) => {
    handleSttClient(socket, {
      apiKey: "bad-key",
      connectUpstream: () => new WebSocket(`ws://127.0.0.1:${httpPort}`),
    });
  });
  const browser = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames = framesOf(browser);
  await new Promise<void>((resolve) => browser.once("close", () => resolve()));
  await waitFor(() => frames.length > 0);
  const payload = JSON.parse(frames[0]!.data.toString()) as { code?: string };
  assert.equal(payload.code, "upstream_unauthorized");
  assert.equal(frames.filter((frame) => frame.data.toString().includes("upstream_unauthorized")).length, 1);

  await new Promise<void>((resolve) => browserServer.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});
