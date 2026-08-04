import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  reconcileElements
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type ServerRequest = {
  type: "request";
  id: string;
  action: "add_elements" | "update_elements" | "delete_elements" | "move_elements" | "export_image";
  payload: Record<string, unknown>;
};

type MoveInstruction = {
  id: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
};

type ServerMessage =
  | { type: "apply"; elements: OrderedExcalidrawElement[] }
  | ServerRequest;

const PUSH_DEBOUNCE_MS = 300;
const RECONNECT_MS = 1000;

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export class SyncClient {
  private api: ExcalidrawImperativeAPI;
  private ws: WebSocket | null = null;
  private pushTimer: number | null = null;
  private applyingRemote = false;

  constructor(api: ExcalidrawImperativeAPI) {
    this.api = api;
    this.connect();
  }

  onLocalChange() {
    if (this.applyingRemote || this.pushTimer !== null) {
      return;
    }
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = null;
      this.pushScene("user");
    }, PUSH_DEBOUNCE_MS);
  }

  private connect() {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    ws.onopen = () => this.pushScene("sync");
    ws.onmessage = (event) => {
      void this.handleMessage(JSON.parse(event.data as string) as ServerMessage);
    };
    ws.onclose = () => {
      this.ws = null;
      window.setTimeout(() => this.connect(), RECONNECT_MS);
    };
    this.ws = ws;
  }

  // origin drives the server-side change tracker: only "user" updates are
  // reported to the model as human edits.
  private pushScene(origin: "user" | "agent" | "sync") {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(
      JSON.stringify({
        type: "scene_update",
        origin,
        elements: this.api.getSceneElementsIncludingDeleted()
      })
    );
  }

  private async handleMessage(message: ServerMessage) {
    if (message.type === "apply") {
      this.applyRemote(message.elements);
      return;
    }
    try {
      const payload = await this.handleRequest(message);
      this.respond(message.id, true, payload);
    } catch (error) {
      this.respond(
        message.id,
        false,
        undefined,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      // Keep the server-side canonical store in sync after tool mutations.
      this.pushScene("agent");
    }
  }

  private applyRemote(remote: OrderedExcalidrawElement[]) {
    const local = this.api.getSceneElementsIncludingDeleted();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reconciled = reconcileElements(local, remote as any, this.api.getAppState());
    this.applyingRemote = true;
    try {
      this.api.updateScene({
        elements: reconciled,
        captureUpdate: CaptureUpdateAction.NEVER
      });
    } finally {
      this.applyingRemote = false;
    }
  }

  private async handleRequest(request: ServerRequest): Promise<unknown> {
    switch (request.action) {
      case "add_elements":
        return this.addElements(request.payload.elements as Record<string, unknown>[]);
      case "update_elements":
        return this.updateElements(
          request.payload.updates as Array<{ id: string } & Record<string, unknown>>
        );
      case "delete_elements":
        return this.deleteElements(request.payload.ids as string[]);
      case "move_elements":
        return this.moveElements(
          request.payload.moves as MoveInstruction[],
          (request.payload.scope as "part" | "element") ?? "part"
        );
      case "export_image":
        return this.exportImage(
          request.payload as { format?: "png" | "svg"; scale?: number; background?: boolean }
        );
      default:
        throw new Error(`Unknown action: ${request.action}`);
    }
  }

  private addElements(skeletons: Record<string, unknown>[]) {
    // regenerateIds: false lets the agent assign stable ids it can reference later.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const converted = convertToExcalidrawElements(skeletons as any, {
      regenerateIds: false
    });
    const routed = this.routeBoundArrows(converted);
    const elements = [...this.api.getSceneElementsIncludingDeleted(), ...routed];
    this.api.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    return { addedIds: routed.map((element) => element.id) };
  }

  // convertToExcalidrawElements registers start/end bindings but keeps the
  // skeleton's default geometry (a 100px horizontal segment), so arrows
  // created without explicit points do not visually reach their targets.
  // Re-route them as straight border-to-border segments.
  private routeBoundArrows<T extends { id: string; type: string }>(converted: readonly T[]): T[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<string, any>(converted.map((element) => [element.id, element]));
    const borderPoint = (
      element: { x: number; y: number; width: number; height: number },
      towards: { x: number; y: number },
      pad = 4
    ) => {
      const cx = element.x + element.width / 2;
      const cy = element.y + element.height / 2;
      const dx = towards.x - cx;
      const dy = towards.y - cy;
      if (dx === 0 && dy === 0) {
        return { x: cx, y: cy };
      }
      const tx = dx !== 0 ? (element.width / 2 + pad) / Math.abs(dx) : Infinity;
      const ty = dy !== 0 ? (element.height / 2 + pad) / Math.abs(dy) : Infinity;
      const t = Math.min(tx, ty, 1);
      return { x: cx + dx * t, y: cy + dy * t };
    };
    return converted.map((element) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const el = element as any;
      if (el.type !== "arrow" || !Array.isArray(el.points) || el.points.length < 2) {
        return element;
      }
      const startTarget = el.startBinding ? byId.get(el.startBinding.elementId) : undefined;
      const endTarget = el.endBinding ? byId.get(el.endBinding.elementId) : undefined;
      if (!startTarget && !endTarget) {
        return element;
      }
      const lastPoint = el.points[el.points.length - 1];
      const currentStart = { x: el.x, y: el.y };
      const currentEnd = { x: el.x + lastPoint[0], y: el.y + lastPoint[1] };
      const startAnchor = startTarget
        ? {
            x: startTarget.x + startTarget.width / 2,
            y: startTarget.y + startTarget.height / 2
          }
        : currentStart;
      const endAnchor = endTarget
        ? { x: endTarget.x + endTarget.width / 2, y: endTarget.y + endTarget.height / 2 }
        : currentEnd;
      const start = startTarget ? borderPoint(startTarget, endAnchor) : currentStart;
      const end = endTarget ? borderPoint(endTarget, startAnchor) : currentEnd;
      return {
        ...el,
        x: start.x,
        y: start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y]
        ],
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y)
      };
    });
  }

  private updateElements(updates: Array<{ id: string } & Record<string, unknown>>) {
    const byId = new Map(updates.map((update) => [update.id, update]));
    const updatedIds: string[] = [];
    const elements = this.api.getSceneElementsIncludingDeleted().map((element) => {
      const update = byId.get(element.id);
      if (!update) {
        return element;
      }
      const { id, ...props } = update;
      updatedIds.push(id);
      return {
        ...element,
        ...props,
        version: element.version + 1,
        versionNonce: randomNonce()
      };
    });
    this.api.updateScene({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: elements as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    const missingIds = updates
      .map((update) => update.id)
      .filter((id) => !updatedIds.includes(id));
    return { updatedIds, missingIds };
  }

  private deleteElements(ids: string[]) {
    const targets = new Set(ids);
    const deletedIds: string[] = [];
    const elements = this.api.getSceneElementsIncludingDeleted().map((element) => {
      if (!targets.has(element.id) || element.isDeleted) {
        return element;
      }
      deletedIds.push(element.id);
      return {
        ...element,
        isDeleted: true,
        version: element.version + 1,
        versionNonce: randomNonce()
      };
    });
    this.api.updateScene({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: elements as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    return { deletedIds };
  }

  private moveElements(moves: MoveInstruction[], scope: "part" | "element") {
    type AnyElement = Record<string, any> & { id: string };
    const alive = this.api
      .getSceneElementsIncludingDeleted()
      .filter((element) => !element.isDeleted) as unknown as AnyElement[];
    const byId = new Map(alive.map((element) => [element.id, element]));

    // Directed adjacency: traversing an edge pulls the target into the moved
    // set. Frames pull children but children do not pull the frame; labels
    // and containers pull each other; group members pull each other; with
    // scope "part", bound arrows and shapes pull each other.
    const edges = new Map<string, Set<string>>();
    const addEdge = (from?: unknown, to?: unknown) => {
      if (typeof from !== "string" || typeof to !== "string") {
        return;
      }
      if (!byId.has(from) || !byId.has(to)) {
        return;
      }
      if (!edges.has(from)) {
        edges.set(from, new Set());
      }
      edges.get(from)!.add(to);
    };
    const groupReps = new Map<string, string>();
    for (const element of alive) {
      if (element.containerId) {
        addEdge(element.id, element.containerId);
        addEdge(element.containerId, element.id);
      }
      if (element.frameId) {
        addEdge(element.frameId, element.id);
      }
      for (const groupId of element.groupIds ?? []) {
        const representative = groupReps.get(groupId);
        if (representative) {
          addEdge(element.id, representative);
          addEdge(representative, element.id);
        } else {
          groupReps.set(groupId, element.id);
        }
      }
      if (scope === "part") {
        for (const binding of [element.startBinding, element.endBinding]) {
          if (binding?.elementId) {
            addEdge(element.id, binding.elementId);
            addEdge(binding.elementId, element.id);
          }
        }
      }
    }

    const expand = (rootId: string): Set<string> => {
      const set = new Set<string>([rootId]);
      const queue = [rootId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of edges.get(current) ?? []) {
          if (!set.has(next)) {
            set.add(next);
            queue.push(next);
          }
        }
      }
      return set;
    };

    const shifted = new Map<string, { dx: number; dy: number }>();
    const results: Array<{ id: string; elementsMoved: number; dx: number; dy: number }> = [];
    const missingIds: string[] = [];
    for (const move of moves) {
      const target = byId.get(move.id);
      if (!target) {
        missingIds.push(move.id);
        continue;
      }
      const set = expand(move.id);
      const members = [...set].map((id) => byId.get(id)!);
      const minX = Math.min(...members.map((member) => member.x as number));
      const minY = Math.min(...members.map((member) => member.y as number));
      const dx = move.dx ?? (move.x !== undefined ? move.x - minX : 0);
      const dy = move.dy ?? (move.y !== undefined ? move.y - minY : 0);
      for (const id of set) {
        shifted.set(id, { dx, dy });
      }
      results.push({ id: move.id, elementsMoved: set.size, dx, dy });
    }

    const pointsBbox = (points: number[][]) => {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      return {
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      };
    };

    const elements = this.api.getSceneElementsIncludingDeleted().map((element) => {
      const el = element as unknown as AnyElement;
      const shift = shifted.get(el.id);
      if (shift) {
        return {
          ...el,
          x: el.x + shift.dx,
          y: el.y + shift.dy,
          version: el.version + 1,
          versionNonce: randomNonce()
        };
      }
      // Arrows outside the moved set with a bound endpoint inside it stretch
      // so the free endpoint stays anchored. Points are relative to (x, y).
      const startShift = el.startBinding?.elementId
        ? shifted.get(el.startBinding.elementId)
        : undefined;
      const endShift = el.endBinding?.elementId ? shifted.get(el.endBinding.elementId) : undefined;
      if (!startShift && !endShift) {
        return element;
      }
      const points: number[][] = (el.points ?? []).map((point: number[]) => [...point]);
      if (points.length < 2) {
        return element;
      }
      let { x, y } = el;
      if (startShift && endShift) {
        x += startShift.dx;
        y += startShift.dy;
        const lastIndex = points.length - 1;
        points[lastIndex][0] += endShift.dx - startShift.dx;
        points[lastIndex][1] += endShift.dy - startShift.dy;
      } else if (startShift) {
        x += startShift.dx;
        y += startShift.dy;
        for (let index = 1; index < points.length; index += 1) {
          points[index][0] -= startShift.dx;
          points[index][1] -= startShift.dy;
        }
      } else if (endShift) {
        const lastIndex = points.length - 1;
        points[lastIndex][0] += endShift.dx;
        points[lastIndex][1] += endShift.dy;
      }
      return {
        ...el,
        x,
        y,
        points,
        ...pointsBbox(points),
        version: el.version + 1,
        versionNonce: randomNonce()
      };
    });
    this.api.updateScene({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: elements as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    return { moved: results, missingIds };
  }

  private async exportImage(payload: {
    format?: "png" | "svg";
    scale?: number;
    background?: boolean;
  }) {
    const elements = this.api.getSceneElements();
    if (elements.length === 0) {
      throw new Error("Canvas is empty");
    }
    const appState = {
      ...this.api.getAppState(),
      exportBackground: payload.background !== false,
      exportWithDarkMode: false
    };
    const files = this.api.getFiles();
    if (payload.format === "svg") {
      const svg = await exportToSvg({ elements, appState, files, exportPadding: 16 });
      return { format: "svg", data: new XMLSerializer().serializeToString(svg) };
    }
    const scale = payload.scale;
    const blob = await exportToBlob({
      elements,
      appState,
      files,
      mimeType: "image/png",
      exportPadding: 16,
      getDimensions: scale
        ? (width: number, height: number) => ({
            width: width * scale,
            height: height * scale,
            scale
          })
        : undefined
    });
    const dataUrl = await blobToDataUrl(blob);
    return { format: "png", data: dataUrl.split(",")[1] };
  }

  private respond(id: string, ok: boolean, payload?: unknown, error?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify({ type: "response", id, ok, payload, error }));
  }
}
