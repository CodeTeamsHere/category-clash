import { DurableObject } from "cloudflare:workers";
import {
  MAX_PLAYERS,
  validateNickname,
  type ClientMessage,
  type GameMode,
  type PlayerInfo,
  type RoomSnapshot,
  type ServerMessage,
} from "../shared/protocol";

// Per-socket data kept across hibernation (structured clone, 16 KB max).
interface SocketAttachment {
  playerId: string | null;
}

interface StoredPlayer {
  id: string;
  nickname: string;
  avatar: string;
  joinedAt: number;
}

interface RoomState {
  code: string;
  mode: GameMode;
  isPublic: boolean;
  status: RoomSnapshot["status"];
  hostId: string | null;
  players: StoredPlayer[];
}

const STATE_KEY = "state";

// One instance per room code. Uses the Hibernation WebSocket API so idle rooms cost nothing.
export class Room extends DurableObject<Env> {
  private state: RoomState | null = null;

  private async load(code: string): Promise<RoomState> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<RoomState>(STATE_KEY);
    this.state = stored ?? {
      code,
      mode: "rarity",
      isPublic: false,
      status: "lobby",
      hostId: null,
      players: [],
    };
    return this.state;
  }

  private async save(): Promise<void> {
    if (this.state) await this.ctx.storage.put(STATE_KEY, this.state);
  }

  async fetch(request: Request): Promise<Response> {
    const code = new URL(request.url).pathname.slice("/ws/".length).toUpperCase();
    const state = await this.load(code);
    if (!state.code) state.code = code;
    await this.save(); // persist the code so a hibernated room can wake with it

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 2000) return this.sendError(ws, "bad_message", "Bad message");
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.sendError(ws, "bad_message", "Bad JSON");
    }

    const state = await this.load("");
    const attachment = ws.deserializeAttachment() as SocketAttachment;

    switch (msg.type) {
      case "ping":
        return this.send(ws, { type: "pong" });

      case "join": {
        const nickname = validateNickname(String(msg.nickname ?? ""));
        if (!nickname) return this.sendError(ws, "bad_nickname", "Nickname must be 2-16 characters");
        const playerId = String(msg.playerId ?? "").slice(0, 64);
        if (!playerId) return this.sendError(ws, "bad_message", "Missing player id");

        const existing = state.players.find((p) => p.id === playerId);
        if (existing) {
          // Reconnect: same seat, refresh name and avatar.
          existing.nickname = nickname;
          existing.avatar = String(msg.avatar ?? existing.avatar).slice(0, 8);
          this.closeOtherSockets(playerId, ws);
        } else {
          if (state.players.length >= MAX_PLAYERS) return this.sendError(ws, "room_full", "Room is full");
          const isFirst = state.players.length === 0;
          state.players.push({ id: playerId, nickname, avatar: String(msg.avatar ?? "").slice(0, 8), joinedAt: Date.now() });
          if (isFirst) state.isPublic = Boolean(msg.isPublic);
        }
        if (!state.hostId) state.hostId = playerId;

        ws.serializeAttachment({ playerId } satisfies SocketAttachment);
        await this.save();
        return this.broadcast();
      }

      case "set_mode": {
        if (!attachment.playerId) return this.sendError(ws, "not_joined", "Join first");
        if (attachment.playerId !== state.hostId) return this.sendError(ws, "not_host", "Only the host can change mode");
        if (msg.mode !== "rarity" && msg.mode !== "elimination") return this.sendError(ws, "bad_message", "Unknown mode");
        state.mode = msg.mode;
        await this.save();
        return this.broadcast();
      }

      default:
        return this.sendError(ws, "bad_message", "Unknown message type");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
      ws.close(code, reason);
    } else {
      ws.close();
    }
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const state = await this.load("");
    const { playerId } = (ws.deserializeAttachment() as SocketAttachment) ?? { playerId: null };
    if (!playerId) return;

    // In the lobby, leaving removes the seat. During a game the seat is kept for reconnect.
    if (state.status === "lobby" && !this.isConnected(playerId, ws)) {
      state.players = state.players.filter((p) => p.id !== playerId);
    }
    if (state.hostId === playerId && !this.isConnected(playerId, ws)) {
      const next = state.players.find((p) => p.id !== playerId && this.isConnected(p.id, ws));
      state.hostId = next?.id ?? null;
    }
    await this.save();
    this.broadcast(ws);
  }

  private socketsFor(playerId: string, exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => {
      if (s === exclude) return false;
      const a = s.deserializeAttachment() as SocketAttachment | null;
      return a?.playerId === playerId;
    });
  }

  private isConnected(playerId: string, exclude?: WebSocket): boolean {
    return this.socketsFor(playerId, exclude).length > 0;
  }

  private closeOtherSockets(playerId: string, keep: WebSocket): void {
    for (const s of this.socketsFor(playerId, keep)) {
      s.serializeAttachment({ playerId: null } satisfies SocketAttachment);
      s.close(4000, "Replaced by new connection");
    }
  }

  private snapshot(exclude?: WebSocket): RoomSnapshot {
    const state = this.state!;
    const players: PlayerInfo[] = state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      connected: this.isConnected(p.id, exclude),
      isHost: p.id === state.hostId,
    }));
    return { code: state.code, mode: state.mode, isPublic: state.isPublic, status: state.status, players };
  }

  private broadcast(exclude?: WebSocket): void {
    const room = this.snapshot(exclude);
    for (const s of this.ctx.getWebSockets()) {
      if (s === exclude) continue;
      const a = s.deserializeAttachment() as SocketAttachment | null;
      if (!a?.playerId) continue;
      this.send(s, { type: "room", room, you: a.playerId });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed; the close handler cleans up.
    }
  }

  private sendError(ws: WebSocket, code: Extract<ServerMessage, { type: "error" }>["code"], message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}
