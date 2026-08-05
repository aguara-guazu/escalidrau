import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { SceneStore } from "./scene.js";
import { CanvasBridge } from "./bridge.js";
import { ChangeTracker } from "./changes.js";
import { createSessionServer } from "./mcp.js";
import { sceneToMermaid } from "./mermaid.js";

export type AppOptions = {
  port?: number;
  webDist?: string;
  dataDir?: string;
};

export type AppHandle = {
  port: number;
  canvasUrl: string;
  mcpUrl: string;
  hasContent: () => boolean;
  exportScene: () => Promise<string>;
  close: () => Promise<void>;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json"
};

const readJsonBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", rejectPromise);
  });

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

export async function startApp(options: AppOptions = {}): Promise<AppHandle> {
  const port = options.port ?? Number(process.env.PORT ?? 3580);
  const webDist = resolve(
    options.webDist ?? fileURLToPath(new URL("../../web/dist", import.meta.url))
  );
  const canvasUrl = `http://localhost:${port}`;
  const mcpUrl = `${canvasUrl}/mcp`;
  const dataDir = options.dataDir ?? join(homedir(), ".escalidrau");
  await mkdir(dataDir, { recursive: true });
  const libraryPath = join(dataDir, "library.json");

  const store = new SceneStore();
  const tracker = new ChangeTracker();
  const bridge = new CanvasBridge(store, tracker, canvasUrl);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (request: IncomingMessage, response: ServerResponse) => {
    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 400, { error: "Unknown or missing mcp-session-id" });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJson(response, 400, { error: "Expected an initialize request to start a session" });
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
      enableDnsRebindingProtection: true,
      allowedHosts: [`localhost:${port}`, `127.0.0.1:${port}`]
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };
    const sessionServer = createSessionServer({ store, bridge, tracker, canvasUrl });
    await sessionServer.connect(transport);
    await transport.handleRequest(request, response, body);
  };

  const serveStatic = async (request: IncomingMessage, response: ServerResponse) => {
    if (!existsSync(webDist)) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("Web build not found. Run `npm run build -w web`.");
      return;
    }
    const urlPath = (request.url ?? "/").split("?")[0];
    const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
    let filePath = resolve(join(webDist, relative));
    if (!filePath.startsWith(webDist + sep) && filePath !== join(webDist, "index.html")) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!existsSync(filePath)) {
      filePath = join(webDist, "index.html");
    }
    try {
      const content = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream"
      });
      response.end(content);
    } catch {
      response.writeHead(500);
      response.end();
    }
  };

  // Installed shape libraries persist on disk so they survive restarts.
  const handleLibrary = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET") {
      try {
        const content = await readFile(libraryPath, "utf8");
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(content);
      } catch {
        sendJson(response, 200, []);
      }
      return;
    }
    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!Array.isArray(body)) {
        sendJson(response, 400, { error: "Expected a library items array" });
        return;
      }
      await writeFile(libraryPath, JSON.stringify(body), "utf8");
      sendJson(response, 200, { ok: true });
      return;
    }
    response.writeHead(405);
    response.end();
  };

  const httpServer: Server = createServer((request, response) => {
    const urlPath = (request.url ?? "/").split("?")[0];
    if (urlPath === "/mcp") {
      void handleMcp(request, response).catch((error) => {
        console.error("[mcp] request failed:", error);
        if (!response.headersSent) {
          sendJson(response, 500, { error: "Internal error" });
        }
      });
      return;
    }
    if (urlPath === "/library") {
      void handleLibrary(request, response).catch(() => {
        if (!response.headersSent) {
          sendJson(response, 500, { error: "Internal error" });
        }
      });
      return;
    }
    if (urlPath === "/mermaid") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(sceneToMermaid(store.all()).mermaid);
      return;
    }
    if (urlPath === "/changes") {
      const since = Number(new URL(request.url ?? "/", canvasUrl).searchParams.get("since") ?? 0);
      sendJson(response, 200, tracker.since(Number.isFinite(since) ? since : 0));
      return;
    }
    void serveStatic(request, response);
  });

  // Only same-origin pages (and the Vite dev server) may join the canvas WS;
  // an arbitrary website could otherwise script the local canvas.
  const allowedOrigins = new Set([
    canvasUrl,
    `http://127.0.0.1:${port}`,
    "http://localhost:3579",
    "http://127.0.0.1:3579"
  ]);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", (socket, request) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      socket.close(1008, "Origin not allowed");
      return;
    }
    bridge.handleConnection(socket);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", rejectPromise);
      resolvePromise();
    });
  });

  httpServer.on("error", (error) => {
    console.error("[escalidrau] HTTP server error:", error);
  });

  return {
    port,
    canvasUrl,
    mcpUrl,
    hasContent: () => store.all().some((element) => !element.isDeleted),
    // Serialized by the renderer (it owns files/images), not from the store.
    exportScene: async () => {
      const result = (await bridge.request("export_scene", {}, 15_000)) as { json: string };
      return result.json;
    },
    close: async () => {
      for (const transport of transports.values()) {
        await transport.close();
      }
      wss.close();
      await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
    }
  };
}
