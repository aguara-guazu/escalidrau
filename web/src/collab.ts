import { joinRoom, selfId } from "trystero";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const APP_ID = "escalidrau-p2p";
const MAX_MEMBERS = 10;
const CURSOR_SEND_MS = 40;
const CURSOR_PUSH_MS = 40;

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
};

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
  private peers = new Map<string, { nick: string }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collaborators = new Map<string, any>();
  private sendCursor: ((data: { x: number; y: number; b?: number }) => void) | null = null;
  private lastCursorSentAt = 0;
  private pushScheduled = false;
  onRoomChange: (info: RoomInfo | null) => void = () => {};
  onRoomFull: () => void = () => {};

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
    const room = joinRoom({ appId: APP_ID }, this.code);
    this.room = room;

    const hello = room.makeAction<{ nick: string }>("hello");
    const cursor = room.makeAction<{ x: number; y: number; b?: number }>("cursor");
    const full = room.makeAction<boolean>("full");
    this.sendCursor = (data) => void cursor.send(data);

    room.onPeerJoin = (peerId: string) => {
      // The owner enforces the room limit; late arrivals are turned away.
      if (this.isOwner && this.peers.size + 1 >= MAX_MEMBERS) {
        void full.send(true, { target: peerId });
        return;
      }
      void hello.send({ nick: this.nick }, { target: peerId });
    };
    hello.onMessage = (data, context) => {
      const peerId = context.peerId;
      const nickname = String(data?.nick ?? "anon").slice(0, 24);
      const known = this.peers.has(peerId);
      this.peers.set(peerId, { nick: nickname });
      if (!known) {
        // Greet back so both sides know each other regardless of join order.
        void hello.send({ nick: this.nick }, { target: peerId });
      }
      this.notify();
    };
    cursor.onMessage = (data, context) => {
      const peer = this.peers.get(context.peerId);
      if (!peer) {
        return;
      }
      this.collaborators.set(context.peerId, {
        username: peer.nick,
        color: this.colorOf(context.peerId),
        pointer: { x: data.x, y: data.y, tool: "pointer" },
        button: data.b ? "down" : "up"
      });
      this.pushCollaborators();
    };
    full.onMessage = () => {
      this.leave();
      this.onRoomFull();
    };
    room.onPeerLeave = (peerId: string) => {
      this.peers.delete(peerId);
      this.collaborators.delete(peerId);
      this.pushCollaborators();
      this.notify();
    };
    this.notify();
  }

  leave() {
    if (!this.room) {
      return;
    }
    void this.room.leave();
    this.room = null;
    this.sendCursor = null;
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

  private members(): RoomMember[] {
    const self: RoomMember = {
      id: selfId,
      nick: this.nick,
      color: this.colorOf(selfId),
      isSelf: true
    };
    const others = [...this.peers.entries()].map(([id, peer]) => ({
      id,
      nick: peer.nick,
      color: this.colorOf(id),
      isSelf: false
    }));
    return [self, ...others];
  }

  private colorOf(peerId: string): { background: string; stroke: string } {
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

  private notify() {
    this.onRoomChange(this.info);
  }
}
