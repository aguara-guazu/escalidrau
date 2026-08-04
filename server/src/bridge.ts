import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { SceneStore, SceneElement } from "./scene.js";
import type { ChangeTracker, ChangeOrigin } from "./changes.js";

type BrowserMessage =
  | { type: "scene_update"; origin?: ChangeOrigin; elements: SceneElement[] }
  | { type: "response"; id: string; ok: boolean; payload?: unknown; error?: string };

type Pending = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Hub between the MCP tools and the browser canvas. Mutations and exports are
 * delegated to the first connected tab (it owns the canvas runtime);
 * scene snapshots flow back, feed the change tracker and fan out to any
 * other tab.
 */
export class CanvasBridge {
  private clients = new Set<WebSocket>();
  private pending = new Map<string, Pending>();

  constructor(
    private store: SceneStore,
    private tracker: ChangeTracker,
    private canvasUrl: string
  ) {}

  handleConnection(socket: WebSocket) {
    this.clients.add(socket);
    socket.send(JSON.stringify({ type: "apply", elements: this.store.all() }));
    socket.on("message", (raw) => {
      try {
        this.handle(socket, JSON.parse(raw.toString()) as BrowserMessage);
      } catch (error) {
        console.error("[bridge] invalid message from canvas:", error);
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  request(action: string, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const client = this.clients.values().next().value as WebSocket | undefined;
    if (!client || client.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          `No canvas connected. Ask the user to open ${this.canvasUrl} (or the desktop app), then retry.`
        )
      );
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Canvas did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      client.send(JSON.stringify({ type: "request", id, action, payload }));
    });
  }

  private handle(sender: WebSocket, message: BrowserMessage) {
    if (message.type === "scene_update") {
      this.store.replace(message.elements);
      this.tracker.record(message.elements, message.origin ?? "user");
      const broadcast = JSON.stringify({ type: "apply", elements: message.elements });
      for (const client of this.clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
          client.send(broadcast);
        }
      }
      return;
    }
    if (message.type === "response") {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.payload);
      } else {
        entry.reject(new Error(message.error ?? "Canvas request failed"));
      }
    }
  }
}
