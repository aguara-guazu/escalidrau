import { joinRoom, selfId } from "trystero";
import { CaptureUpdateAction, reconcileElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const APP_ID = "escalidrau-p2p";
const MAX_MEMBERS = 10;
const CURSOR_SEND_MS = 40;
const CURSOR_PUSH_MS = 40;
const SCENE_FLUSH_MS = 150;
const SNAPSHOT_RETRY_MS = 3000;
const IDLE_AFTER_MS = 20_000;
const IDLE_SWEEP_MS = 5000;

// Distinct cursor colors; assignment is order-independent (sorted peer ids)
// so every member sees the same color for the same person.
export const CURSOR_COLORS: Array<{ background: string; stroke: string }> = [
  { background: "#e03131", stroke: "#c92a2a" },
  { background: "#1971c2", stroke: "#1864ab" },
  { background: "#2f9e44", stroke: "#2b8a3e" },
  { background: "#f08c00", stroke: "#e8590c" },
  { background: "#9c36b5", stroke: "#862e9c" },
  { background: "#0c8599", stroke: "#0b7285" },
  { background: "#e8590c", stroke: "#d9480f" },
  { background: "#66a80f", stroke: "#5c940d" },
  { background: "#d6336c", stroke: "#c2255c" },
  { background: "#3b5bdb", stroke: "#364fc7" }
];

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const createRoomCode = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
};

export type RoomMember = {
  id: string;
  nick: string;
  color: { background: string; stroke: string };
  isSelf: boolean;
  isHost: boolean;
};

export type MemberEvent =
  | { kind: "join"; nick: string }
  | { kind: "leave"; nick: string }
  | { kind: "host"; nick: string; isSelf: boolean };

export type RoomInfo = {
  code: string;
  isOwner: boolean;
  members: RoomMember[];
};

type PointerPayload = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button: "down" | "up";
};

type TrysteroRoom = ReturnType<typeof joinRoom>;

export class CollabClient {
  private api: ExcalidrawImperativeAPI;
  private room: TrysteroRoom | null = null;
  private code = "";
  private nick = "";
  private isOwner = false;
  private peers = new Map<string, { nick: string; colorIndex?: number }>();
  // null = automatic (derived from the sorted peer ids).
  private preferredColor: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collaborators = new Map<string, any>();
  private sendCursor: ((data: { x: number; y: number; b?: number }) => void) | null = null;
  private lastCursorSentAt = 0;
  private pushScheduled = false;
  // Signature of the last version of each element we sent or received; keeps
  // broadcasts incremental and prevents echoing a peer's change back.
  private knownVersions = new Map<string, string>();
  private sentFileIds = new Set<string>();
  private sceneFlushTimer: number | null = null;
  private snapshotSettled = false;
  private snapshotAskedTo = new Set<string>();
  private ownerId: string | null = null;
  private lastSeen = new Map<string, number>();
  private idleTimer: number | null = null;
  private announceColor: (() => void) | null = null;
  // Bumped on every join/leave; handlers bound to a previous session ignore
  // late messages (e.g. a peer that was told the room is full).
  private session = 0;
  private sendScene: ((elements: unknown[], target?: string) => void) | null = null;
  private sendFiles: ((files: unknown, target?: string) => void) | null = null;
  private askSnapshot: ((target: string) => void) | null = null;
  onRoomChange: (info: RoomInfo | null) => void = () => {};
  onRoomFull: () => void = () => {};
  onMemberEvent: (event: MemberEvent) => void = () => {};

  constructor(api: ExcalidrawImperativeAPI) {
    this.api = api;
  }

  get info(): RoomInfo | null {
    if (!this.room) {
      return null;
    }
    return { code: this.code, isOwner: this.isOwner, members: this.members() };
  }

  join(code: string, nick: string, isOwner: boolean) {
    this.leave();
    this.code = code.trim().toUpperCase();
    this.nick = nick.trim().slice(0, 24) || "anon";
    this.isOwner = isOwner;
    this.knownVersions.clear();
    this.sentFileIds.clear();
    this.snapshotAskedTo.clear();
    // The room creator is the initial source of truth; joiners pull a snapshot.
    this.snapshotSettled = isOwner;
    this.ownerId = isOwner ? selfId : null;
    this.lastSeen.clear();
    const room = joinRoom({ appId: APP_ID }, this.code);
    this.room = room;
    this.session += 1;
    const session = this.session;
    const stale = () => session !== this.session;

    const hello = room.makeAction<{ nick: string; owner?: boolean; color?: number | null }>("hello");
    const cursor = room.makeAction<{ x: number; y: number; b?: number }>("cursor");
    const full = room.makeAction<boolean>("full");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = room.makeAction<any>("scene");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const files = room.makeAction<any>("files");
    const snapReq = room.makeAction<boolean>("snapreq");
    this.sendCursor = (data) => void cursor.send(data);
    this.sendScene = (elements, target) =>
      void scene.send({ elements }, target ? { target } : undefined);
    this.sendFiles = (payload, target) =>
      void files.send({ files: payload }, target ? { target } : undefined);
    this.askSnapshot = (target) => void snapReq.send(true, { target });

    scene.onMessage = (data) => {
      if (stale()) {
        return;
      }
      const elements = (data?.elements ?? []) as Array<Record<string, unknown>>;
      if (elements.length > 0) {
        this.applyRemoteElements(elements);
      }
    };
    files.onMessage = (data) => {
      if (stale()) {
        return;
      }
      const payload = data?.files as Record<string, unknown> | undefined;
      if (payload) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.api.addFiles(Object.values(payload) as any);
      }
    };
    snapReq.onMessage = (_data, context) => {
      if (stale()) {
        return;
      }
      this.sendSnapshot(context.peerId);
    };

    room.onPeerJoin = (peerId: string) => {
      if (stale()) {
        return;
      }
      // The owner enforces the room limit; late arrivals are turned away.
      if (this.isOwner && this.peers.size + 1 >= MAX_MEMBERS) {
        void full.send(true, { target: peerId });
        return;
      }
      void hello.send(
        { nick: this.nick, owner: this.isOwner, color: this.preferredColor },
        { target: peerId }
      );
    };
    hello.onMessage = (data, context) => {
      if (stale()) {
        return;
      }
      const peerId = context.peerId;
      const nickname = String(data?.nick ?? "anon").slice(0, 24);
      const known = this.peers.has(peerId);
      if (this.isOwner && !known && this.peers.size + 1 >= MAX_MEMBERS) {
        void full.send(true, { target: peerId });
        return;
      }
      const declared = typeof data?.color === "number" ? data.color : undefined;
      this.peers.set(peerId, { nick: nickname, colorIndex: declared });
      this.lastSeen.set(peerId, Date.now());
      // A peer can change colour mid-session; refresh the cursor already shown.
      const shown = this.collaborators.get(peerId);
      if (shown) {
        this.collaborators.set(peerId, { ...shown, color: this.colorOf(peerId) });
        this.pushCollaborators();
      }
      if (data?.owner) {
        this.ownerId = peerId;
      }
      if (!known) {
        // Greet back so both sides know each other regardless of join order.
        void hello.send(
          { nick: this.nick, owner: this.isOwner, color: this.preferredColor },
          { target: peerId }
        );
        this.onMemberEvent({ kind: "join", nick: nickname });
      }
      this.maybeRequestSnapshot(peerId);
      this.notify();
    };
    cursor.onMessage = (data, context) => {
      if (stale()) {
        return;
      }
      const peer = this.peers.get(context.peerId);
      if (!peer) {
        return;
      }
      this.lastSeen.set(context.peerId, Date.now());
      this.collaborators.set(context.peerId, {
        username: peer.nick,
        userState: "active",
        color: this.colorOf(context.peerId),
        pointer: { x: data.x, y: data.y, tool: "pointer" },
        button: data.b ? "down" : "up"
      });
      this.pushCollaborators();
    };
    full.onMessage = () => {
      if (stale()) {
        return;
      }
      this.leave();
      this.onRoomFull();
    };
    room.onPeerLeave = (peerId: string) => {
      if (stale()) {
        return;
      }
      const nick = this.peers.get(peerId)?.nick;
      this.peers.delete(peerId);
      this.collaborators.delete(peerId);
      this.lastSeen.delete(peerId);
      this.pushCollaborators();
      if (nick) {
        this.onMemberEvent({ kind: "leave", nick });
      }
      // Everyone replicates the scene, so losing the host does not end the
      // room: the lowest peer id takes over (same winner on every side).
      if (peerId === this.ownerId) {
        const candidates = [selfId, ...this.peers.keys()].sort();
        const elected = candidates[0];
        this.ownerId = elected;
        this.isOwner = elected === selfId;
        this.snapshotSettled = true;
        this.onMemberEvent({
          kind: "host",
          nick: this.isOwner ? this.nick : this.peers.get(elected)?.nick ?? "someone",
          isSelf: this.isOwner
        });
      }
      this.notify();
    };
    this.announceColor = () => {
      void hello.send({ nick: this.nick, owner: this.isOwner, color: this.preferredColor });
    };
    this.startIdleSweep();
    this.notify();
  }

  leave() {
    if (!this.room) {
      return;
    }
    void this.room.leave();
    this.room = null;
    this.session += 1;
    this.sendCursor = null;
    this.announceColor = null;
    this.sendScene = null;
    this.sendFiles = null;
    this.askSnapshot = null;
    if (this.sceneFlushTimer !== null) {
      window.clearTimeout(this.sceneFlushTimer);
      this.sceneFlushTimer = null;
    }
    this.knownVersions.clear();
    this.sentFileIds.clear();
    this.peers.clear();
    this.collaborators.clear();
    this.api.updateScene({ collaborators: new Map() });
    this.notify();
  }

  handlePointer(payload: PointerPayload) {
    if (!this.room || !this.sendCursor) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCursorSentAt < CURSOR_SEND_MS) {
      return;
    }
    this.lastCursorSentAt = now;
    void this.sendCursor({
      x: Math.round(payload.pointer.x),
      y: Math.round(payload.pointer.y),
      b: payload.button === "down" ? 1 : 0
    });
  }

  get colorChoice(): number | null {
    return this.preferredColor;
  }

  /** Sets the local cursor colour (null restores the automatic one). */
  setColorChoice(index: number | null) {
    this.preferredColor = index;
    this.announceColor?.();
    this.notify();
  }

  /** Called on every local scene change; broadcasts only what actually moved. */
  onLocalChange() {
    if (!this.room || this.sceneFlushTimer !== null) {
      return;
    }
    this.sceneFlushTimer = window.setTimeout(() => {
      this.sceneFlushTimer = null;
      this.flushScene();
    }, SCENE_FLUSH_MS);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private signature(element: Record<string, any>): string {
    return `${element.version}:${element.versionNonce}`;
  }

  private flushScene() {
    if (!this.room || !this.sendScene) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = this.api.getSceneElementsIncludingDeleted() as unknown as Array<Record<string, any>>;
    const changed = all.filter(
      (element) => this.knownVersions.get(element.id) !== this.signature(element)
    );
    if (changed.length === 0) {
      return;
    }
    for (const element of changed) {
      this.knownVersions.set(element.id, this.signature(element));
    }
    this.sendPendingFiles(changed);
    this.sendScene(changed);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendPendingFiles(elements: Array<Record<string, any>>, target?: string) {
    if (!this.sendFiles) {
      return;
    }
    const wanted = elements
      .map((element) => element.fileId as string | undefined)
      .filter((fileId): fileId is string => typeof fileId === "string")
      .filter((fileId) => target !== undefined || !this.sentFileIds.has(fileId));
    if (wanted.length === 0) {
      return;
    }
    const available = this.api.getFiles();
    const payload: Record<string, unknown> = {};
    for (const fileId of wanted) {
      const file = available[fileId as keyof typeof available];
      if (file) {
        payload[fileId] = file;
        this.sentFileIds.add(fileId);
      }
    }
    if (Object.keys(payload).length > 0) {
      this.sendFiles(payload, target);
    }
  }

  private applyRemoteElements(remote: Array<Record<string, unknown>>) {
    for (const element of remote) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.knownVersions.set(element.id as string, this.signature(element as Record<string, any>));
    }
    const local = this.api.getSceneElementsIncludingDeleted();
    const reconciled = reconcileElements(
      local,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      remote as any,
      this.api.getAppState()
    );
    this.api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
    this.snapshotSettled = true;
  }

  // A joiner pulls the current scene from one peer only (lowest id wins) and
  // retries with another if that peer never answers.
  private maybeRequestSnapshot(peerId: string) {
    if (this.snapshotSettled || !this.askSnapshot || this.snapshotAskedTo.has(peerId)) {
      return;
    }
    this.snapshotAskedTo.add(peerId);
    this.askSnapshot(peerId);
    window.setTimeout(() => {
      if (this.snapshotSettled || !this.room) {
        return;
      }
      const next = [...this.peers.keys()].find((id) => !this.snapshotAskedTo.has(id));
      if (next) {
        this.maybeRequestSnapshot(next);
      }
    }, SNAPSHOT_RETRY_MS);
  }

  private sendSnapshot(target: string) {
    if (!this.sendScene) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = this.api.getSceneElementsIncludingDeleted() as unknown as Array<Record<string, any>>;
    for (const element of all) {
      this.knownVersions.set(element.id, this.signature(element));
    }
    this.sendPendingFiles(all, target);
    this.sendScene(all, target);
  }

  private members(): RoomMember[] {
    const self: RoomMember = {
      id: selfId,
      nick: this.nick,
      color: this.colorOf(selfId),
      isSelf: true,
      isHost: this.ownerId === selfId
    };
    const others = [...this.peers.entries()].map(([id, peer]) => ({
      id,
      nick: peer.nick,
      color: this.colorOf(id),
      isSelf: false,
      isHost: this.ownerId === id
    }));
    return [self, ...others];
  }

  private colorOf(peerId: string): { background: string; stroke: string } {
    const chosen =
      peerId === selfId ? this.preferredColor : this.peers.get(peerId)?.colorIndex ?? null;
    if (chosen !== null && chosen !== undefined && CURSOR_COLORS[chosen]) {
      return CURSOR_COLORS[chosen];
    }
    const ids = [selfId, ...this.peers.keys()].sort();
    const index = Math.max(0, ids.indexOf(peerId));
    return CURSOR_COLORS[index % CURSOR_COLORS.length];
  }

  private pushCollaborators() {
    if (this.pushScheduled) {
      return;
    }
    this.pushScheduled = true;
    window.setTimeout(() => {
      this.pushScheduled = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.api.updateScene({ collaborators: new Map(this.collaborators) as any });
    }, CURSOR_PUSH_MS);
  }

  // Cursors of people who stopped moving fade to idle instead of lingering
  // as if they were still there.
  private startIdleSweep() {
    if (this.idleTimer !== null) {
      return;
    }
    this.idleTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [peerId, collaborator] of this.collaborators) {
        const idle = now - (this.lastSeen.get(peerId) ?? 0) > IDLE_AFTER_MS;
        const state = idle ? "idle" : "active";
        if (collaborator.userState !== state) {
          this.collaborators.set(peerId, { ...collaborator, userState: state });
          changed = true;
        }
      }
      if (changed) {
        this.pushCollaborators();
      }
    }, IDLE_SWEEP_MS);
  }

  private notify() {
    this.onRoomChange(this.info);
  }
}
