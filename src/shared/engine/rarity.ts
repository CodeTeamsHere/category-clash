import { TIER_POINTS, TIER_NAMES, type Category, type Tier } from "../category";
import { matchAnswer } from "../matcher";

// Rarity mode: players take turns naming something in the round's category.
// A valid, unused answer scores by its rarity tier. Pure functions only:
// the Room Durable Object owns time (now), randomness and persistence.

export interface RaritySettings {
  rounds: number;
  turnsPerPlayer: number;
  turnSeconds: number;
}

export const RARITY_DEFAULTS: RaritySettings = { rounds: 5, turnsPerPlayer: 2, turnSeconds: 15 };
export const RARITY_LIMITS = {
  rounds: [1, 10],
  turnsPerPlayer: [1, 5],
  turnSeconds: [5, 60],
} as const satisfies Record<keyof RaritySettings, readonly [number, number]>;

export const ROUND_END_MS = 7000;

export type RarityPhase = "turn" | "round_end" | "game_over";

export interface PlayedAnswer {
  answerId: string;
  answer: string; // canonical spelling
  tier: Tier;
  tierName: string;
  points: number;
}

export interface TurnRecord {
  playerId: string;
  result: "answered" | "timeout" | "skipped";
  played?: PlayedAnswer;
}

export interface RoundSummary {
  categoryId: string;
  prompt: string;
  best: { playerId: string; played: PlayedAnswer } | null;
}

export interface RarityState {
  mode: "rarity";
  settings: RaritySettings;
  categoryIds: string[]; // one per round, chosen at start
  round: number; // 0-based
  phase: RarityPhase;
  turnOrder: string[]; // player ids for the current round
  turnIndex: number; // turns taken this round
  deadline: number; // epoch ms when the current phase ends; 0 when over
  scores: Record<string, number>;
  turns: TurnRecord[]; // this round
  usedAnswerIds: string[]; // this round
  roundSummaries: RoundSummary[];
}

export type RejectReason = "not_your_turn" | "time_up" | "not_in_list" | "taken" | "empty";

export type SubmitResult =
  | { ok: true; state: RarityState; played: PlayedAnswer }
  | { ok: false; reason: RejectReason; taken?: string };

export type CategoryLookup = (id: string) => Category | undefined;

export function clampSettings(input: Partial<RaritySettings>): RaritySettings {
  const pick = (key: keyof RaritySettings) => {
    const raw = Number(input[key] ?? RARITY_DEFAULTS[key]);
    const [lo, hi] = RARITY_LIMITS[key];
    return Number.isFinite(raw) ? Math.min(hi, Math.max(lo, Math.round(raw))) : RARITY_DEFAULTS[key];
  };
  return { rounds: pick("rounds"), turnsPerPlayer: pick("turnsPerPlayer"), turnSeconds: pick("turnSeconds") };
}

export function turnsPerRound(state: RarityState): number {
  return state.turnOrder.length * state.settings.turnsPerPlayer;
}

export function currentPlayer(state: RarityState): string | null {
  if (state.phase !== "turn" || state.turnOrder.length === 0) return null;
  return state.turnOrder[state.turnIndex % state.turnOrder.length];
}

export function startRarity(
  players: string[],
  categoryIds: string[],
  settings: RaritySettings,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): RarityState {
  if (players.length === 0) throw new Error("No players");
  if (categoryIds.length === 0) throw new Error("No categories");
  const state: RarityState = {
    mode: "rarity",
    settings: { ...settings, rounds: categoryIds.length },
    categoryIds,
    round: 0,
    phase: "turn",
    turnOrder: [...players],
    turnIndex: 0,
    deadline: now + settings.turnSeconds * 1000,
    scores: Object.fromEntries(players.map((p) => [p, 0])),
    turns: [],
    usedAnswerIds: [],
    roundSummaries: [],
  };
  return skipInactive(state, now, connected, lookup);
}

export function submitRarity(
  state: RarityState,
  playerId: string,
  text: string,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): SubmitResult {
  if (state.phase !== "turn" || currentPlayer(state) !== playerId) return { ok: false, reason: "not_your_turn" };
  if (now > state.deadline) return { ok: false, reason: "time_up" };
  if (!text.trim()) return { ok: false, reason: "empty" };

  const category = lookup(state.categoryIds[state.round]);
  if (!category) return { ok: false, reason: "not_in_list" };
  const match = matchAnswer(category, text);
  if (!match) return { ok: false, reason: "not_in_list" };
  if (state.usedAnswerIds.includes(match.id)) return { ok: false, reason: "taken", taken: match.answer.canonical };

  const played: PlayedAnswer = {
    answerId: match.id,
    answer: match.answer.canonical,
    tier: match.answer.tier,
    tierName: TIER_NAMES[match.answer.tier],
    points: TIER_POINTS[match.answer.tier],
  };
  const next: RarityState = {
    ...state,
    scores: { ...state.scores, [playerId]: (state.scores[playerId] ?? 0) + played.points },
    turns: [...state.turns, { playerId, result: "answered", played }],
    usedAnswerIds: [...state.usedAnswerIds, match.id],
  };
  return { ok: true, played, state: advance(next, now, connected, lookup) };
}

// Called when the deadline passes (DO alarm). No-op before the deadline.
export function tickRarity(
  state: RarityState,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): RarityState {
  if (state.phase === "game_over" || now < state.deadline) return state;

  if (state.phase === "turn") {
    const playerId = currentPlayer(state)!;
    const next = { ...state, turns: [...state.turns, { playerId, result: "timeout" as const }] };
    return advance(next, now, connected, lookup);
  }

  // round_end -> next round or game over
  if (state.round + 1 >= state.categoryIds.length) {
    return { ...state, phase: "game_over", deadline: 0 };
  }
  const order = rotate(state.turnOrder);
  const next: RarityState = {
    ...state,
    round: state.round + 1,
    phase: "turn",
    turnOrder: order,
    turnIndex: 0,
    turns: [],
    usedAnswerIds: [],
    deadline: now + state.settings.turnSeconds * 1000,
  };
  return skipInactive(next, now, connected, lookup);
}

function rotate<T>(list: T[]): T[] {
  return list.length < 2 ? [...list] : [...list.slice(1), list[0]];
}

function advance(state: RarityState, now: number, connected: ReadonlySet<string>, lookup: CategoryLookup): RarityState {
  const next = { ...state, turnIndex: state.turnIndex + 1 };
  if (next.turnIndex >= turnsPerRound(next)) return endRound(next, now, lookup);
  next.deadline = now + next.settings.turnSeconds * 1000;
  return skipInactive(next, now, connected, lookup);
}

// Disconnected players lose their turn immediately instead of stalling the table.
function skipInactive(state: RarityState, now: number, connected: ReadonlySet<string>, lookup: CategoryLookup): RarityState {
  let next = state;
  while (next.phase === "turn") {
    const playerId = currentPlayer(next)!;
    if (connected.has(playerId)) return next;
    next = { ...next, turns: [...next.turns, { playerId, result: "skipped" }], turnIndex: next.turnIndex + 1 };
    if (next.turnIndex >= turnsPerRound(next)) return endRound(next, now, lookup);
  }
  return next;
}

function endRound(state: RarityState, now: number, lookup: CategoryLookup): RarityState {
  const categoryId = state.categoryIds[state.round];
  let best: RoundSummary["best"] = null;
  for (const turn of state.turns) {
    if (turn.played && (!best || turn.played.points > best.played.points)) {
      best = { playerId: turn.playerId, played: turn.played };
    }
  }
  return {
    ...state,
    phase: "round_end",
    deadline: now + ROUND_END_MS,
    roundSummaries: [...state.roundSummaries, { categoryId, prompt: lookup(categoryId)?.prompt ?? categoryId, best }],
  };
}

// What clients see: everything except future categories.
export interface RarityView {
  mode: "rarity";
  settings: RaritySettings;
  round: number;
  totalRounds: number;
  phase: RarityPhase;
  prompt: string;
  turnOrder: string[];
  turnIndex: number;
  turnsPerRound: number;
  currentPlayerId: string | null;
  deadline: number;
  scores: Record<string, number>;
  turns: TurnRecord[];
  roundSummaries: RoundSummary[];
}

export function rarityView(state: RarityState, lookup: CategoryLookup): RarityView {
  return {
    mode: "rarity",
    settings: state.settings,
    round: state.round,
    totalRounds: state.categoryIds.length,
    phase: state.phase,
    prompt: lookup(state.categoryIds[state.round])?.prompt ?? "",
    turnOrder: state.turnOrder,
    turnIndex: state.turnIndex,
    turnsPerRound: turnsPerRound(state),
    currentPlayerId: currentPlayer(state),
    deadline: state.deadline,
    scores: state.scores,
    turns: state.turns,
    roundSummaries: state.roundSummaries,
  };
}
