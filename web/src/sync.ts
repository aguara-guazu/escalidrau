import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  reconcileElements,
  serializeAsJSON
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type ServerRequest = {
  type: "request";
  id: string;
  action:
    | "add_elements"
    | "update_elements"
    | "delete_elements"
    | "move_elements"
    | "import_mermaid"
    | "export_image"
    | "export_scene"
    | "view_canvas"
    | "render_library"
    | "add_library_item"
    | "connect_elements";
  payload: Record<string, unknown>;
};

type Connection = {
  from: string;
  to: string;
  label?: string;
  route?: "straight" | "elbow";
  strokeColor?: string;
  strokeStyle?: "solid" | "dashed" | "dotted";
  startArrowhead?: "arrow" | "triangle" | "bar" | "dot" | "none";
  endArrowhead?: "arrow" | "triangle" | "bar" | "dot" | "none";
};

type Box = { x: number; y: number; width: number; height: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyElement = Record<string, any> & { id: string; type: string };

const boxOf = (elements: AnyElement[]): Box => {
  const minX = Math.min(...elements.map((element) => element.x as number));
  const minY = Math.min(...elements.map((element) => element.y as number));
  const maxX = Math.max(...elements.map((element) => (element.x as number) + (element.width as number)));
  const maxY = Math.max(...elements.map((element) => (element.y as number) + (element.height as number)));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const centerOf = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// Distance from a point outside an axis-aligned box to its border (0 inside).
const distanceToBox = (point: { x: number; y: number }, box: Box) => {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
};

// Point on the border of a shape (ellipse, diamond or box for everything
// else) along the ray from its centre towards `towards`, pushed `pad` px out.
const borderPoint = (
  element: Box & { type?: string },
  towards: { x: number; y: number },
  pad: number
) => {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const dx = towards.x - cx;
  const dy = towards.y - cy;
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }
  const a = element.width / 2;
  const b = element.height / 2;
  let border: number;
  if (element.type === "ellipse") {
    border = 1 / Math.hypot(dx / a, dy / b);
  } else if (element.type === "diamond") {
    border = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  } else {
    const tx = dx !== 0 ? a / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? b / Math.abs(dy) : Infinity;
    border = Math.min(tx, ty);
  }
  const t = Math.min(border + pad / Math.hypot(dx, dy), 1);
  return { x: cx + dx * t, y: cy + dy * t };
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
  | { type: "reset" }
  | ServerRequest;

const PUSH_DEBOUNCE_MS = 300;
const RECONNECT_MS = 1000;

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

const freshId = () =>
  Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 11);

// Library items are element groups with internal references (groups, labels,
// bindings); every placement must be an independent clone with remapped ids.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cloneLibraryElements = (elements: Array<Record<string, any>>): Array<Record<string, any>> => {
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  for (const element of elements) {
    idMap.set(element.id, freshId());
  }
  const mapId = (id: unknown) => (typeof id === "string" && idMap.get(id)) || id;
  return elements.map((element) => ({
    ...element,
    id: idMap.get(element.id),
    seed: randomNonce(),
    version: 1,
    versionNonce: randomNonce(),
    isDeleted: false,
    groupIds: ((element.groupIds as string[] | undefined) ?? []).map((groupId) => {
      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, freshId());
      }
      return groupMap.get(groupId)!;
    }),
    containerId: element.containerId ? mapId(element.containerId) : element.containerId ?? null,
    frameId: element.frameId ? mapId(element.frameId) : element.frameId ?? null,
    boundElements: element.boundElements
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        element.boundElements.map((bound: any) => ({ ...bound, id: mapId(bound.id) }))
      : element.boundElements ?? null,
    startBinding: element.startBinding
      ? { ...element.startBinding, elementId: mapId(element.startBinding.elementId) }
      : element.startBinding ?? null,
    endBinding: element.endBinding
      ? { ...element.endBinding, elementId: mapId(element.endBinding.elementId) }
      : element.endBinding ?? null
  }));
};

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

  // Hard reset shared with all clients. Soft-deleting (the library's "clear
  // canvas") keeps ghosts in the scene and the welcome screen never returns;
  // resetScene() empties it for real, and the server clears its store so
  // reconciliation with other clients cannot resurrect the old elements.
  resetCanvas() {
    this.applyingRemote = true;
    try {
      this.api.resetScene();
    } finally {
      this.applyingRemote = false;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "scene_reset", origin: "user" }));
    }
  }

  private async handleMessage(message: ServerMessage) {
    if (message.type === "apply") {
      this.applyRemote(message.elements);
      return;
    }
    if (message.type === "reset") {
      this.applyingRemote = true;
      try {
        this.api.resetScene();
      } finally {
        this.applyingRemote = false;
      }
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
      case "import_mermaid":
        return this.insertMermaid(request.payload.mermaid as string);
      case "export_scene":
        return {
          json: serializeAsJSON(
            this.api.getSceneElements(),
            this.api.getAppState(),
            this.api.getFiles(),
            "local"
          )
        };
      case "view_canvas":
        return this.viewCanvas(request.payload.ids as string[] | undefined);
      case "render_library":
        return this.renderLibrary(
          request.payload.items as Array<{ label: string; elements: Array<Record<string, unknown>> }>
        );
      case "add_library_item":
        return this.addLibraryItem(
          request.payload as {
            elements: Array<Record<string, unknown>>;
            x: number;
            y: number;
            label?: string;
          }
        );
      case "connect_elements":
        return this.connectElements(request.payload.connections as Connection[]);
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
  //
  // The bindings computed by convertToExcalidrawElements describe that same
  // placeholder geometry: focus can land far outside its valid [-1, 1] range
  // and gap can be tens of px. Excalidraw re-derives arrow endpoints from
  // focus/gap on every later recompute (dragging or resizing a bound shape),
  // so stale values snap arrows to corners, freeze them mid-air or teleport
  // the endpoint to the out-of-range focus point. After routing, rewrite each
  // binding to focus 0 (aim at the shape center) with the routed gap.
  private static readonly ARROW_BORDER_PAD = 4;

  private routeBoundArrows<T extends { id: string; type: string }>(converted: readonly T[]): T[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<string, any>(converted.map((element) => [element.id, element]));
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
      const start = startTarget ? borderPoint(startTarget, endAnchor, SyncClient.ARROW_BORDER_PAD) : currentStart;
      const end = endTarget ? borderPoint(endTarget, startAnchor, SyncClient.ARROW_BORDER_PAD) : currentEnd;
      const routedGap = Math.max(1, SyncClient.ARROW_BORDER_PAD);
      return {
        ...el,
        x: start.x,
        y: start.y,
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y]
        ],
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        startBinding: startTarget
          ? { ...el.startBinding, focus: 0, gap: routedGap }
          : el.startBinding,
        endBinding: endTarget ? { ...el.endBinding, focus: 0, gap: routedGap } : el.endBinding
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

  // Shared by the in-app import dialog and the import_mermaid MCP action.
  // New content lands below the existing scene and the viewport follows it.
  async insertMermaid(definition: string) {
    const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
    const { elements: skeleton, files } = await parseMermaidToExcalidraw(definition);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const converted = convertToExcalidrawElements(skeleton as any, { regenerateIds: true });
    if (converted.length === 0) {
      throw new Error("The Mermaid definition produced no elements");
    }
    const existing = this.api.getSceneElements();
    let placed = converted;
    if (existing.length > 0) {
      const targetX = Math.min(...existing.map((element) => element.x));
      const targetY = Math.max(...existing.map((element) => element.y + element.height)) + 80;
      const dx = targetX - Math.min(...converted.map((element) => element.x));
      const dy = targetY - Math.min(...converted.map((element) => element.y));
      placed = converted.map((element) => ({ ...element, x: element.x + dx, y: element.y + dy }));
    }
    if (files) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.api.addFiles(Object.values(files) as any);
    }
    this.api.updateScene({
      elements: [...this.api.getSceneElementsIncludingDeleted(), ...placed],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.api.scrollToContent(placed as any, { fitToViewport: true, animate: true });
    return { addedIds: placed.map((element) => element.id) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async renderPng(elements: Array<Record<string, any>>) {
    const minX = Math.min(...elements.map((element) => element.x as number));
    const minY = Math.min(...elements.map((element) => element.y as number));
    const maxX = Math.max(...elements.map((element) => (element.x as number) + (element.width as number)));
    const maxY = Math.max(...elements.map((element) => (element.y as number) + (element.height as number)));
    const maxSide = Math.max(maxX - minX, maxY - minY) + 32;
    const scale = Math.min(3, Math.max(0.2, 1600 / maxSide));
    const blob = await exportToBlob({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: elements as any,
      appState: {
        ...this.api.getAppState(),
        exportBackground: true,
        exportWithDarkMode: false
      },
      files: this.api.getFiles(),
      mimeType: "image/png",
      exportPadding: 16,
      getDimensions: (width: number, height: number) => ({
        width: width * scale,
        height: height * scale,
        scale
      })
    });
    const dataUrl = await blobToDataUrl(blob);
    return { data: dataUrl.split(",")[1] };
  }

  private async renderLibrary(
    items: Array<{ label: string; elements: Array<Record<string, unknown>> }>
  ) {
    const columns = 5;
    const gap = 48;
    const labelHeight = 34;
    const prepared = items.map(({ label, elements }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cloned = cloneLibraryElements(elements as Array<Record<string, any>>);
      const minX = Math.min(...cloned.map((element) => element.x as number));
      const minY = Math.min(...cloned.map((element) => element.y as number));
      const width =
        Math.max(...cloned.map((element) => (element.x as number) + (element.width as number))) - minX;
      const height =
        Math.max(...cloned.map((element) => (element.y as number) + (element.height as number))) - minY;
      return { label, cloned, minX, minY, width, height };
    });
    // Labels are measured before laying out the grid so a cell is at least as
    // wide as its label (long official names otherwise run into the next cell).
    const labelElements = convertToExcalidrawElements(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prepared.map((item) => ({ type: "text", x: 0, y: 0, text: item.label, fontSize: 16 })) as any
    );
    const cellWidth =
      Math.max(
        ...prepared.map((item) => item.width),
        ...labelElements.map((element) => element.width),
        60
      ) + gap;
    const cellHeight = Math.max(...prepared.map((item) => item.height), 40) + labelHeight + gap;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sheet: Array<Record<string, any>> = [];
    prepared.forEach((item, position) => {
      const offsetX = (position % columns) * cellWidth;
      const offsetY = Math.floor(position / columns) * cellHeight;
      const centering = (cellWidth - gap - item.width) / 2;
      sheet.push(
        ...item.cloned.map((element) => ({
          ...element,
          x: (element.x as number) - item.minX + offsetX + centering,
          y: (element.y as number) - item.minY + offsetY
        }))
      );
      sheet.push({
        ...labelElements[position],
        x: offsetX,
        y: offsetY + cellHeight - labelHeight - gap / 2
      });
    });
    return this.renderPng(sheet);
  }

  // x/y anchor the item's main shape (largest non-text element — the icon or
  // the group box), so items placed on a grid line up regardless of how wide
  // their labels are. The label text can be replaced at placement time; the
  // replacement is re-measured and keeps the original alignment anchor.
  private addLibraryItem(payload: {
    elements: Array<Record<string, unknown>>;
    x: number;
    y: number;
    label?: string;
  }) {
    const cloned = cloneLibraryElements(payload.elements as AnyElement[]) as AnyElement[];
    const shapes = cloned.filter((element) => element.type !== "text");
    const anchor =
      shapes.length > 0
        ? shapes.reduce((best, element) =>
            (element.width as number) * (element.height as number) >
            (best.width as number) * (best.height as number)
              ? element
              : best
          )
        : cloned[0];
    const dx = payload.x - (anchor.x as number);
    const dy = payload.y - (anchor.y as number);
    let placed: AnyElement[] = cloned.map((element) => ({
      ...element,
      x: (element.x as number) + dx,
      y: (element.y as number) + dy
    }));
    if (payload.label !== undefined) {
      const labels = placed.filter((element) => element.type === "text" && !element.containerId);
      if (labels.length > 0) {
        const template = labels[0];
        const replacement = convertToExcalidrawElements(
          [
            {
              type: "text",
              text: payload.label,
              fontSize: template.fontSize,
              fontFamily: template.fontFamily,
              textAlign: template.textAlign,
              strokeColor: template.strokeColor,
              x:
                template.textAlign === "center"
                  ? (template.x as number) + (template.width as number) / 2
                  : template.textAlign === "right"
                    ? (template.x as number) + (template.width as number)
                    : template.x,
              y: template.y,
              groupIds: template.groupIds
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
          { regenerateIds: true }
        ) as unknown as AnyElement[];
        placed = [...placed.filter((element) => !labels.includes(element)), ...replacement];
      }
    }
    this.api.updateScene({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: [...this.api.getSceneElementsIncludingDeleted(), ...placed] as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    return {
      addedIds: placed.map((element) => element.id),
      added: placed.map((element) => ({
        id: element.id,
        type: element.type,
        x: Math.round(element.x as number),
        y: Math.round(element.y as number),
        width: Math.round(element.width as number),
        height: Math.round(element.height as number)
      }))
    };
  }

  private static readonly CONNECTOR_PAD = 6;

  // The "item" around an icon is the icon plus the text labels it is grouped
  // with; vertical connectors leave and enter through the item so they clear
  // the label, horizontal ones through the icon on its centre line.
  private itemBoxes(element: AnyElement, alive: AnyElement[]) {
    const icon: Box & { type: string } = {
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height
    };
    const groupIds = (element.groupIds as string[] | undefined) ?? [];
    const labels =
      groupIds.length === 0
        ? []
        : alive.filter(
            (candidate) =>
              candidate.type === "text" &&
              candidate.id !== element.id &&
              ((candidate.groupIds as string[] | undefined) ?? []).some((groupId) =>
                groupIds.includes(groupId)
              )
          );
    const item = boxOf([element, ...labels]);
    // Column through the icon, spanning the item vertically.
    const column: Box & { type: string } = {
      type: "rectangle",
      x: icon.x,
      y: item.y,
      width: icon.width,
      height: item.height
    };
    return { icon, item, column };
  }

  private connectElements(connections: Connection[]) {
    const alive = this.api
      .getSceneElementsIncludingDeleted()
      .filter((element) => !element.isDeleted) as unknown as AnyElement[];
    const byId = new Map(alive.map((element) => [element.id, element]));
    const pad = SyncClient.CONNECTOR_PAD;
    const additions: AnyElement[] = [];
    const boundTo = new Map<string, string[]>();
    const connected: Array<{ id: string; from: string; to: string }> = [];
    const missingIds: string[] = [];
    for (const connection of connections) {
      const source = byId.get(connection.from);
      const target = byId.get(connection.to);
      if (!source || !target) {
        missingIds.push(...[connection.from, connection.to].filter((id) => !byId.has(id)));
        continue;
      }
      const s = this.itemBoxes(source, alive);
      const t = this.itemBoxes(target, alive);
      const sc = centerOf(s.icon);
      const tc = centerOf(t.icon);
      const dx = tc.x - sc.x;
      const dy = tc.y - sc.y;
      const horizontal = Math.abs(dx) >= Math.abs(dy);
      const aligned = horizontal ? Math.abs(dy) < 1 : Math.abs(dx) < 1;
      let start: { x: number; y: number };
      let end: { x: number; y: number };
      let corner: { x: number; y: number } | null = null;
      if (connection.route === "elbow" && !aligned) {
        if (horizontal) {
          start = { x: dx >= 0 ? s.icon.x + s.icon.width + pad : s.icon.x - pad, y: sc.y };
          end = { x: tc.x, y: dy >= 0 ? t.icon.y - pad : t.item.y + t.item.height + pad };
          corner = { x: end.x, y: start.y };
        } else {
          start = { x: sc.x, y: dy >= 0 ? s.item.y + s.item.height + pad : s.icon.y - pad };
          end = { x: dx >= 0 ? t.icon.x - pad : t.icon.x + t.icon.width + pad, y: tc.y };
          corner = { x: start.x, y: end.y };
        }
      } else if (horizontal) {
        start = borderPoint(s.icon, tc, pad);
        end = borderPoint(t.icon, sc, pad);
      } else {
        start = borderPoint(s.column, tc, pad);
        end = borderPoint(t.column, sc, pad);
      }
      const points = corner
        ? [
            [0, 0],
            [corner.x - start.x, corner.y - start.y],
            [end.x - start.x, end.y - start.y]
          ]
        : [
            [0, 0],
            [end.x - start.x, end.y - start.y]
          ];
      const arrowhead = (value: Connection["endArrowhead"], fallback: string | null) =>
        value === undefined ? fallback : value === "none" ? null : value;
      const skeleton: Record<string, unknown> = {
        type: "arrow",
        x: start.x,
        y: start.y,
        points,
        strokeColor: connection.strokeColor ?? "#1e1e1e",
        strokeStyle: connection.strokeStyle ?? "solid",
        startArrowhead: arrowhead(connection.startArrowhead, null),
        endArrowhead: arrowhead(connection.endArrowhead, "arrow"),
        ...(connection.label ? { label: { text: connection.label, fontSize: 16 } } : {})
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const converted = convertToExcalidrawElements([skeleton] as any, {
        regenerateIds: true
      }) as unknown as AnyElement[];
      const arrow = converted.find((element) => element.type === "arrow");
      if (!arrow) {
        continue;
      }
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      const bound = {
        ...arrow,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        startBinding: {
          elementId: source.id,
          focus: 0,
          gap: Math.max(1, distanceToBox(start, s.icon))
        },
        endBinding: { elementId: target.id, focus: 0, gap: Math.max(1, distanceToBox(end, t.icon)) }
      };
      additions.push(bound, ...converted.filter((element) => element !== arrow));
      for (const id of [source.id, target.id]) {
        boundTo.set(id, [...(boundTo.get(id) ?? []), bound.id]);
      }
      connected.push({ id: bound.id, from: source.id, to: target.id });
    }
    const elements = this.api.getSceneElementsIncludingDeleted().map((element) => {
      const arrows = boundTo.get(element.id);
      if (!arrows) {
        return element;
      }
      const el = element as unknown as AnyElement;
      return {
        ...el,
        boundElements: [
          ...((el.boundElements as Array<{ id: string; type: string }> | null) ?? []),
          ...arrows.map((id) => ({ id, type: "arrow" }))
        ],
        version: (el.version as number) + 1,
        versionNonce: randomNonce()
      };
    });
    this.api.updateScene({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements: [...elements, ...additions] as any,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY
    });
    return { connected, missingIds };
  }

  // Agent-facing render: fits the longest side to ~1600px so text stays
  // legible at the resolution vision models actually process.
  private async viewCanvas(ids?: string[]) {
    const all = this.api.getSceneElements();
    const targets =
      ids && ids.length > 0 ? all.filter((element) => ids.includes(element.id)) : all;
    if (targets.length === 0) {
      throw new Error("Nothing to render — the canvas (or that part) is empty");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.renderPng(targets as any);
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
