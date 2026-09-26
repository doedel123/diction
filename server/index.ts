import { createServer, type IncomingMessage } from "http";
import type { Duplex } from "stream";
import { parse } from "url";
import { loadEnvConfig } from "@next/env";
import next from "next";
import { WebSocketServer } from "ws";
import { handleSttClient } from "./stt-proxy";

const dev = process.env.NODE_ENV !== "production";
loadEnvConfig(process.cwd(), dev);

const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

async function main() {
  await app.prepare();

  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "/", true);
    void handle(req, res, parsedUrl).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const delegatedUpgrades: UpgradeListener[] = [];

  // Next registers its own HMR upgrade listener on the first request.
  // Keep that listener, but claim /api/stt before it can see the socket.
  const originalOn = server.on.bind(server);
  server.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "upgrade") {
      delegatedUpgrades.push(listener as UpgradeListener);
      return server;
    }
    return originalOn(event, listener as UpgradeListener);
  }) as typeof server.on;

  originalOn("upgrade", (req, socket, head) => {
    const pathname = parse(req.url ?? "").pathname;
    if (pathname === "/api/stt") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleSttClient(ws);
      });
      return;
    }
    if (delegatedUpgrades.length === 0) {
      socket.destroy();
      return;
    }
    for (const listener of delegatedUpgrades) listener(req, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });

  console.log(`Diktat läuft auf http://localhost:${port}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
