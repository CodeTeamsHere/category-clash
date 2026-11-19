import { DurableObject } from "cloudflare:workers";
import { CATEGORIES, getCategory } from "../content";
import {
  RARITY_DEFAULTS,
  clampSettings,
  rarityView,
  startRarity,
  submitRarity,
  tickRarity,
  type RaritySettings,
  type RarityState,
} from "../shared/engine/rarity";
import {
  ANSWER_MAX,
  MAX_PLAYERS,
  validateNickname,
  type ClientMessage,
  type ErrorCode,
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
  settings: RaritySettings;
  game: RarityState | null;
}

const STATE_KEY = "state";

// One instance per room code. Uses the Hibernation WebSocket API so idle rooms cost nothing.
// Turn timers use the Durable Object alarm (setTimeout would keep the object awake).
export class Room extends DurableObject<Env> {
  private state: RoomState | null = null;

  private async load(code = ""): Promise<RoomState> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<RoomState>(STATE_KEY);
    this.state = {
      code,
      mode: "rarity",
      isPublic: false,
      status: "lobby",
      hostId: null,
      players: [],
      settings: RARITY_DEFAULTS,
      game: null,
      ...stored, // older stored states may lack newer fields
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

    const state = await this.load();
    const { playerId } = ws.deserializeAttachment() as SocketAttachment;

    if (msg.type === "ping") return this.send(ws, { type: "pong" });
    if (msg.type === "join") return this.handleJoin(ws, state, msg);
    if (!playerId) return this.sendError(ws, "not_joined", "Join first");

    const isHost = playerId === state.hostId;
    switch (msg.type) {
      case "set_mode": {
        if (!isHost) return this.sendError(ws, "not_host", "Only the host can change mode");
        if (state.status !== "lobby") return this.sendError(ws, "bad_state", "Game in progress");
        if (msg.mode !== "rarity" && msg.mode !== "elimination") return this.sendError(ws, "bad_message", "Unknown mode");
        state.mode = msg.mode;
        break;
      }

      case "set_settings": {
        if (!isHost) return this.sendError(ws, "not_host", "Only the host can change settings");
        if (state.status !== "lobby") return this.sendError(ws, "bad_state", "Game in progress");
        state.settings = clampSettings({ ...state.settings, ...msg.settings });
        break;
      }

      case "start_game": {
        if (!isHost) return this.sendError(ws, "not_host", "Only the host can start");
        if (state.status !== "lobby") return this.sendError(ws, "bad_state", "Game already started");
        if (state.mode !== "rarity") return this.sendError(ws, "not_supported", "Elimination mode is coming soon");
        const connected = this.connectedIds();
        const players = state.players.filter((p) => connected.has(p.id)).map((p) => p.id);
        if (players.length === 0) return this.sendError(ws, "bad_state", "No players");
        state.players = state.players.filter((p) => connected.has(p.id)); // drop stale seats
        const rounds = Math.min(state.settings.rounds, CATEGORIES.length);
        const categoryIds = shuffle(CATEGORIES.map((c) => c.id)).slice(0, rounds);
        state.game = startRarity(players, categoryIds, state.settings, Date.now(), connected, getCategory);
        state.status = "playing";
        break;
      }

      case "submit_answer": {
        if (!state.game) return this.sendError(ws, "bad_state", "No game running");
        const text = String(msg.text ?? "").slice(0, ANSWER_MAX);
        const result = submitRarity(state.game, playerId, text, Date.now(), this.connectedIds(), getCategory);
        if (!result.ok) {
          if (result.reason === "not_in_list") {
            // Logged for content curation: answers players expected to count.
            console.log(JSON.stringify({ event: "miss", category: state.game.categoryIds[state.game.round], text }));
          }
          return this.send(ws, { type: "answer_rejected", reason: result.reason, text, taken: result.taken });
        }
        state.game = result.state;
        break;
      }

      case "back_to_lobby": {
        if (!isHost) return this.sendError(ws, "not_host", "Only the host can do that");
        this.resetToLobby(state);
        break;
      }

      default:
        return this.sendError(ws, "bad_message", "Unknown message type");
    }

    await this.commit();
  }

  private async handleJoin(ws: WebSocket, state: RoomState, msg: Extract<ClientMessage, { type: "join" }>) {
    const nickname = validateNickname(String(msg.nickname ?? ""));
    if (!nickname) return this.sendError(ws, "bad_nickname", "Nickname must be 2-16 characters");
    const playerId = String(msg.playerId ?? "").slice(0, 64);
    if (!playerId) return this.sendError(ws, "bad_message", "Missing player id");
    const avatar = String(msg.avatar ?? "").slice(0, 8);

    const existing = state.players.find((p) => p.id === playerId);
    if (existing) {
      // Reconnect: same seat, refresh name and avatar.
      existing.nickname = nickname;
      existing.avatar = avatar || existing.avatar;
      this.closeOtherSockets(playerId, ws);
    } else {
      if (state.players.length >= MAX_PLAYERS) return this.sendError(ws, "room_full", "Room is full");
      const isFirst = state.players.length === 0;
      state.players.push({ id: playerId, nickname, avatar, joinedAt: Date.now() });
      if (isFirst) state.isPublic = Boolean(msg.isPublic);
    }
    if (!state.hostId) state.hostId = playerId;

    ws.serializeAttachment({ playerId } satisfies SocketAttachment);
    await this.commit();
  }

  // Timer fired: advance the game (turn timeout or end of intermission).
  async alarm(): Promise<void> {
    const state = await this.load();
    if (!state.game) return;
    const connected = this.connectedIds();
    if (connected.size === 0) {
      // Everyone left mid-game: stop the clock until someone comes back.
      this.resetToLobby(state);
      await this.save();
      return;
    }
    state.game = tickRarity(state.game, Date.now(), connected, getCategory);
    await this.commit();
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
    const state = await this.load();
    const { playerId } = (ws.deserializeAttachment() as SocketAttachment | null) ?? { playerId: null };
    if (!playerId) return;
    try {
      ws.serializeAttachment({ playerId: null } satisfies SocketAttachment);
    } catch {
      // already closed; readyState check in connectedIds() covers it
    }
    if (this.isConnected(playerId)) return; // another tab still holds the seat

    // In the lobby, leaving frees the seat. During a game it is kept for reconnect.
    if (state.status === "lobby") state.players = state.players.filter((p) => p.id !== playerId);
    if (state.hostId === playerId) {
      const next = state.players.find((p) => p.id !== playerId && this.isConnected(p.id));
      state.hostId = next?.id ?? null;
    }
    await this.commit();
  }

  private resetToLobby(state: RoomState): void {
    state.status = "lobby";
    state.game = null;
    const connected = this.connectedIds();
    state.players = state.players.filter((p) => connected.has(p.id));
    if (state.hostId && !connected.has(state.hostId)) state.hostId = state.players[0]?.id ?? null;
  }

  // Persist, schedule the next timer, broadcast.
  private async commit(): Promise<void> {
    const state = this.state!;
    await this.save();
    const deadline = state.game && state.game.phase !== "game_over" ? state.game.deadline : 0;
    if (deadline) await this.ctx.storage.setAlarm(deadline);
    else await this.ctx.storage.deleteAlarm();
    this.broadcast();
  }

  private playerIdOf(ws: WebSocket): string | null {
    return (ws.deserializeAttachment() as SocketAttachment | null)?.playerId ?? null;
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.ctx.getWebSockets()) {
      if (s.readyState !== WebSocket.OPEN) continue; // closing sockets no longer count
      const id = this.playerIdOf(s);
      if (id) ids.add(id);
    }
    return ids;
  }

  private isConnected(playerId: string): boolean {
    return this.connectedIds().has(playerId);
  }

  private closeOtherSockets(playerId: string, keep: WebSocket): void {
    for (const s of this.ctx.getWebSockets()) {
      if (s === keep || this.playerIdOf(s) !== playerId) continue;
      s.serializeAttachment({ playerId: null } satisfies SocketAttachment);
      s.close(4000, "Replaced by new connection");
    }
  }

  private snapshot(): RoomSnapshot {
    const state = this.state!;
    const connected = this.connectedIds();
    const players: PlayerInfo[] = state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      connected: connected.has(p.id),
      isHost: p.id === state.hostId,
    }));
    return {
      code: state.code,
      mode: state.mode,
      isPublic: state.isPublic,
      status: state.status,
      players,
      settings: state.settings,
      game: state.game ? rarityView(state.game, getCategory) : null,
    };
  }

  private broadcast(): void {
    const room = this.snapshot();
    const serverNow = Date.now();
    for (const s of this.ctx.getWebSockets()) {
      const id = this.playerIdOf(s);
      if (id) this.send(s, { type: "room", room, you: id, serverNow });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket already closed; the close handler cleans up.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }
}

function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
