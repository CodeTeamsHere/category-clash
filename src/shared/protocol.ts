// Messages exchanged over the room WebSocket. The server is authoritative:
// clients send intents, the Room Durable Object validates them and broadcasts state.

import type { GameMode, GameSettings, GameView } from "./engine";
import type { RejectReason } from "./engine/rarity";

export type { GameMode, GameSettings, GameView };

export const MAX_PLAYERS = 10;
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 16;
export const ANSWER_MAX = 60;

export const AVATARS = ["🦊", "🐙", "🐸", "🦉", "🐼", "🦄", "🐢", "🦖", "🐝", "🐳", "🦀", "🐧"] as const;
export type Avatar = (typeof AVATARS)[number];

export interface PlayerInfo {
  id: string;
  nickname: string;
  avatar: string;
  connected: boolean;
  isHost: boolean;
}

export interface RoomSnapshot {
  code: string;
  mode: GameMode;
  isPublic: boolean;
  status: "lobby" | "playing";
  players: PlayerInfo[];
  settings: GameSettings;
  game: GameView | null;
}

export type ClientMessage =
  | { type: "join"; playerId: string; nickname: string; avatar: string; isPublic?: boolean }
  | { type: "set_mode"; mode: GameMode }
  | { type: "set_settings"; mode: GameMode; settings: Record<string, number> }
  | { type: "start_game" }
  | { type: "submit_answer"; text: string }
  | { type: "back_to_lobby" }
  | { type: "ping" };

export type ServerMessage =
  | { type: "room"; room: RoomSnapshot; you: string; serverNow: number }
  | { type: "answer_rejected"; reason: RejectReason; text: string; taken?: string }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "pong" };

export type ErrorCode =
  | "bad_message"
  | "bad_nickname"
  | "room_full"
  | "not_host"
  | "not_joined"
  | "bad_state"
  | "not_supported";

// Room codes: 4 letters, no ambiguous characters (I, O) and no vowels so codes never spell words.
export const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const ROOM_CODE_LENGTH = 4;

export function generateRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

export function validateNickname(input: string): string | null {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length < NICKNAME_MIN || name.length > NICKNAME_MAX) return null;
  return name;
}
