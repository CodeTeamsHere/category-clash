import { AVATARS } from "../shared/protocol";

// Guest identity lives in localStorage. Every access is guarded: storage can be
// blocked (private windows, strict settings) and the app must still work.

const KEY = "category-clash:identity";

export interface Identity {
  playerId: string;
  nickname: string;
  avatar: string;
}

function randomId(): string {
  return crypto.randomUUID();
}

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.playerId) {
        return { playerId: parsed.playerId, nickname: parsed.nickname ?? "", avatar: parsed.avatar ?? AVATARS[0] };
      }
    }
  } catch {
    // ignore
  }
  return { playerId: randomId(), nickname: "", avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)] };
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    // ignore
  }
}
