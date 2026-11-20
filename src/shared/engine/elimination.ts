import { TIER_NAMES } from "../category";
import { matchAnswer } from "../matcher";
import { ROUND_END_MS, type CategoryLookup, type PlayedAnswer, type RejectReason } from "./rarity";

// Elimination mode: players take turns naming something in the category.
// A valid, unused answer passes the turn. Running out of time costs a life.
// The turn timer shrinks every lap. Last player standing wins the round;
// first to `roundsToWin` round wins takes the match.

export interface EliminationSettings {
  lives: number;
  startSeconds: number;
  roundsToWin: number;
}

export const ELIMINATION_DEFAULTS: EliminationSettings = { lives: 3, startSeconds: 12, roundsToWin: 2 };
export const ELIMINATION_LIMITS = {
  lives: [1, 5],
  startSeconds: [5, 30],
  roundsToWin: [1, 5],
} as const satisfies Record<keyof EliminationSettings, readonly [number, number]>;

export const MIN_TURN_SECONDS = 5;
export const SHRINK_PER_LAP_SECONDS = 1;
export const ELIMINATION_MIN_PLAYERS = 2;

export type EliminationPhase = "turn" | "round_end" | "game_over";

export interface EliminationTurn {
  playerId: string;
  result: "answered" | "timeout" | "skipped";
  played?: PlayedAnswer;
  livesLeft: number;
}

export interface EliminationRoundSummary {
  categoryId: string;
  prompt: string;
  winnerId: string | null;
  answers: number;
}

export interface EliminationState {
  mode: "elimination";
  settings: EliminationSettings;
  categoryIds: string[]; // cycled if there are more rounds than categories
  round: number; // 0-based
  phase: EliminationPhase;
  seats: string[]; // fixed seat order
  roundStarter: number; // seat index that opens the current round
  lives: Record<string, number>;
  wins: Record<string, number>;
  current: string | null;
  turnCount: number; // turns taken this round, drives the shrinking timer
  turnMs: number; // length of the current turn
  deadline: number;
  turns: EliminationTurn[]; // this round
  usedAnswerIds: string[]; // this round
  roundWinner: string | null;
  matchWinner: string | null;
  roundSummaries: EliminationRoundSummary[];
}

export type EliminationSubmitResult =
  | { ok: true; state: EliminationState; played: PlayedAnswer }
  | { ok: false; reason: RejectReason; taken?: string };

export function clampEliminationSettings(input: Partial<EliminationSettings>): EliminationSettings {
  const pick = (key: keyof EliminationSettings) => {
    const raw = Number(input[key] ?? ELIMINATION_DEFAULTS[key]);
    const [lo, hi] = ELIMINATION_LIMITS[key];
    return Number.isFinite(raw) ? Math.min(hi, Math.max(lo, Math.round(raw))) : ELIMINATION_DEFAULTS[key];
  };
  return { lives: pick("lives"), startSeconds: pick("startSeconds"), roundsToWin: pick("roundsToWin") };
}

export function alivePlayers(state: EliminationState): string[] {
  return state.seats.filter((id) => (state.lives[id] ?? 0) > 0);
}

export function categoryForRound(state: EliminationState): string {
  return state.categoryIds[state.round % state.categoryIds.length];
}

// Timer starts at startSeconds and loses SHRINK_PER_LAP_SECONDS each full lap of the living players.
export function turnSecondsFor(state: EliminationState): number {
  const laps = Math.floor(state.turnCount / Math.max(1, alivePlayers(state).length));
  return Math.max(MIN_TURN_SECONDS, Math.min(state.settings.startSeconds, state.settings.startSeconds - laps * SHRINK_PER_LAP_SECONDS));
}

function nextAlive(state: EliminationState, fromId: string): string | null {
  const n = state.seats.length;
  const start = state.seats.indexOf(fromId);
  for (let i = 1; i <= n; i++) {
    const id = state.seats[(start + i) % n];
    if ((state.lives[id] ?? 0) > 0) return id;
  }
  return null;
}

function beginTurn(state: EliminationState, playerId: string, now: number): EliminationState {
  const next = { ...state, current: playerId };
  next.turnMs = turnSecondsFor(next) * 1000;
  next.deadline = now + next.turnMs;
  return next;
}

export function startElimination(
  players: string[],
  categoryIds: string[],
  settings: EliminationSettings,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): EliminationState {
  if (players.length < ELIMINATION_MIN_PLAYERS) throw new Error("Elimination needs at least 2 players");
  if (categoryIds.length === 0) throw new Error("No categories");
  const base: EliminationState = {
    mode: "elimination",
    settings,
    categoryIds,
    round: 0,
    phase: "turn",
    seats: [...players],
    roundStarter: 0,
    lives: Object.fromEntries(players.map((p) => [p, settings.lives])),
    wins: Object.fromEntries(players.map((p) => [p, 0])),
    current: null,
    turnCount: 0,
    turnMs: 0,
    deadline: 0,
    turns: [],
    usedAnswerIds: [],
    roundWinner: null,
    matchWinner: null,
    roundSummaries: [],
  };
  return resolveInactive(beginTurn(base, players[0], now), now, connected, lookup);
}

export function submitElimination(
  state: EliminationState,
  playerId: string,
  text: string,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): EliminationSubmitResult {
  if (state.phase !== "turn" || state.current !== playerId) return { ok: false, reason: "not_your_turn" };
  if (now > state.deadline) return { ok: false, reason: "time_up" };
  if (!text.trim()) return { ok: false, reason: "empty" };

  const category = lookup(categoryForRound(state));
  if (!category) return { ok: false, reason: "not_in_list" };
  const match = matchAnswer(category, text);
  if (!match) return { ok: false, reason: "not_in_list" };
  if (state.usedAnswerIds.includes(match.id)) return { ok: false, reason: "taken", taken: match.answer.canonical };

  const played: PlayedAnswer = {
    answerId: match.id,
    answer: match.answer.canonical,
    tier: match.answer.tier,
    tierName: TIER_NAMES[match.answer.tier],
    points: 0,
  };
  let next: EliminationState = {
    ...state,
    turns: [...state.turns, { playerId, result: "answered", played, livesLeft: state.lives[playerId] ?? 0 }],
    usedAnswerIds: [...state.usedAnswerIds, match.id],
    turnCount: state.turnCount + 1,
  };
  next = beginTurn(next, nextAlive(next, playerId) ?? playerId, now);
  return { ok: true, played, state: resolveInactive(next, now, connected, lookup) };
}

export function tickElimination(
  state: EliminationState,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): EliminationState {
  if (state.phase === "game_over" || now < state.deadline) return state;

  if (state.phase === "turn") {
    return resolveInactive(loseLife(state, state.current!, "timeout", now, lookup), now, connected, lookup);
  }

  // round_end -> game over or next round
  if (state.matchWinner) return { ...state, phase: "game_over", deadline: 0, current: null };
  const roundStarter = (state.roundStarter + 1) % state.seats.length;
  const next: EliminationState = {
    ...state,
    round: state.round + 1,
    phase: "turn",
    roundStarter,
    lives: Object.fromEntries(state.seats.map((p) => [p, state.settings.lives])),
    turnCount: 0,
    turns: [],
    usedAnswerIds: [],
    roundWinner: null,
  };
  return resolveInactive(beginTurn(next, state.seats[roundStarter], now), now, connected, lookup);
}

function loseLife(
  state: EliminationState,
  playerId: string,
  result: "timeout" | "skipped",
  now: number,
  lookup: CategoryLookup,
): EliminationState {
  const livesLeft = Math.max(0, (state.lives[playerId] ?? 0) - 1);
  const next: EliminationState = {
    ...state,
    lives: { ...state.lives, [playerId]: livesLeft },
    turns: [...state.turns, { playerId, result, livesLeft }],
    turnCount: state.turnCount + 1,
  };
  if (alivePlayers(next).length <= 1) return endRound(next, now, lookup);
  return beginTurn(next, nextAlive(next, playerId)!, now);
}

// Disconnected players lose a life when their turn comes instead of stalling the table.
function resolveInactive(
  state: EliminationState,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): EliminationState {
  let next = state;
  while (next.phase === "turn" && next.current && !connected.has(next.current)) {
    next = loseLife(next, next.current, "skipped", now, lookup);
  }
  return next;
}

function endRound(state: EliminationState, now: number, lookup: CategoryLookup): EliminationState {
  const alive = alivePlayers(state);
  const winner = alive.length === 1 ? alive[0] : null;
  const wins = winner ? { ...state.wins, [winner]: (state.wins[winner] ?? 0) + 1 } : state.wins;
  const matchWinner = winner && wins[winner] >= state.settings.roundsToWin ? winner : null;
  const categoryId = categoryForRound(state);
  return {
    ...state,
    phase: "round_end",
    current: null,
    deadline: now + ROUND_END_MS,
    wins,
    roundWinner: winner,
    matchWinner,
    roundSummaries: [
      ...state.roundSummaries,
      {
        categoryId,
        prompt: lookup(categoryId)?.prompt ?? categoryId,
        winnerId: winner,
        answers: state.turns.filter((t) => t.result === "answered").length,
      },
    ],
  };
}

// What clients see: everything except future categories.
export interface EliminationView {
  mode: "elimination";
  settings: EliminationSettings;
  round: number;
  phase: EliminationPhase;
  prompt: string;
  seats: string[];
  lives: Record<string, number>;
  wins: Record<string, number>;
  currentPlayerId: string | null;
  turnMs: number;
  deadline: number;
  turns: EliminationTurn[];
  roundWinner: string | null;
  matchWinner: string | null;
  roundSummaries: EliminationRoundSummary[];
}

export function eliminationView(state: EliminationState, lookup: CategoryLookup): EliminationView {
  return {
    mode: "elimination",
    settings: state.settings,
    round: state.round,
    phase: state.phase,
    prompt: lookup(categoryForRound(state))?.prompt ?? "",
    seats: state.seats,
    lives: state.lives,
    wins: state.wins,
    currentPlayerId: state.current,
    turnMs: state.turnMs,
    deadline: state.deadline,
    turns: state.turns,
    roundWinner: state.roundWinner,
    matchWinner: state.matchWinner,
    roundSummaries: state.roundSummaries,
  };
}
