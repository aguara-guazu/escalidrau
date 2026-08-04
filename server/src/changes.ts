import type { SceneElement } from "./scene.js";

export type ChangeOrigin = "user" | "agent" | "sync";

type ElementSnapshot = {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  strokeColor?: string;
  backgroundColor?: string;
  isDeleted: boolean;
};

type Snapshot = Map<string, ElementSnapshot>;

type ChangeKind = "added" | "deleted" | "geometry" | "text" | "style";

type ChangeEntry = {
  seq: number;
  elementId: string;
  kind: ChangeKind;
  summary: string;
};

const MAX_ENTRIES = 200;

const truncate = (value: string, max = 60) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const toSnapshot = (elements: SceneElement[]): Snapshot => {
  const snapshot: Snapshot = new Map();
  for (const element of elements) {
    snapshot.set(element.id, {
      type: element.type,
      x: Math.round(element.x as number),
      y: Math.round(element.y as number),
      width: Math.round(element.width as number),
      height: Math.round(element.height as number),
      text: typeof element.text === "string" ? element.text : undefined,
      strokeColor: element.strokeColor as string | undefined,
      backgroundColor: element.backgroundColor as string | undefined,
      isDeleted: Boolean(element.isDeleted)
    });
  }
  return snapshot;
};

const diffSnapshots = (
  previous: Snapshot,
  next: Snapshot
): Array<Omit<ChangeEntry, "seq">> => {
  const changes: Array<Omit<ChangeEntry, "seq">> = [];
  for (const [id, element] of next) {
    const before = previous.get(id);
    if (!before) {
      if (!element.isDeleted) {
        const text = element.text ? ` ("${truncate(element.text)}")` : "";
        changes.push({
          elementId: id,
          kind: "added",
          summary: `added ${element.type} "${id}"${text} at (${element.x}, ${element.y})`
        });
      }
      continue;
    }
    if (!before.isDeleted && element.isDeleted) {
      changes.push({
        elementId: id,
        kind: "deleted",
        summary: `deleted ${element.type} "${id}"`
      });
      continue;
    }
    if (element.isDeleted) {
      continue;
    }
    if (
      before.x !== element.x ||
      before.y !== element.y ||
      before.width !== element.width ||
      before.height !== element.height
    ) {
      changes.push({
        elementId: id,
        kind: "geometry",
        summary: `moved/resized ${element.type} "${id}" to (${element.x}, ${element.y}) ${element.width}×${element.height}`
      });
    }
    if (before.text !== element.text && element.text !== undefined) {
      changes.push({
        elementId: id,
        kind: "text",
        summary: `changed text of "${id}" to "${truncate(element.text)}"`
      });
    }
    if (
      before.strokeColor !== element.strokeColor ||
      before.backgroundColor !== element.backgroundColor
    ) {
      changes.push({
        elementId: id,
        kind: "style",
        summary: `restyled ${element.type} "${id}"`
      });
    }
  }
  for (const [id, element] of previous) {
    if (!next.has(id) && !element.isDeleted) {
      changes.push({
        elementId: id,
        kind: "deleted",
        summary: `deleted ${element.type} "${id}"`
      });
    }
  }
  return changes;
};

/**
 * Records scene diffs attributed to the human user so MCP sessions can report
 * them to the model. Agent- and sync-originated updates advance the snapshot
 * without generating entries. Repeated changes to the same element (e.g. a
 * drag emitting many updates) coalesce into the latest state.
 */
export class ChangeTracker {
  private seq = 0;
  private entries: ChangeEntry[] = [];
  private snapshot: Snapshot = new Map();
  private listeners = new Set<() => void>();

  get current(): number {
    return this.seq;
  }

  /** Notifies when the user makes a change; returns an unsubscribe function. */
  onUserChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(elements: SceneElement[], origin: ChangeOrigin) {
    const next = toSnapshot(elements);
    const changes = origin === "user" ? diffSnapshots(this.snapshot, next) : [];
    this.snapshot = next;
    for (const change of changes) {
      const existing = this.entries.findIndex(
        (entry) => entry.elementId === change.elementId && entry.kind === change.kind
      );
      if (existing !== -1) {
        this.entries.splice(existing, 1);
      }
      this.entries.push({ ...change, seq: ++this.seq });
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    if (changes.length > 0) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  since(seq: number): { seq: number; summaries: string[] } {
    const pending = this.entries.filter((entry) => entry.seq > seq);
    return { seq: this.seq, summaries: pending.map((entry) => entry.summary) };
  }
}
