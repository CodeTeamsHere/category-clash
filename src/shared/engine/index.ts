// Mode dispatch so the Room Durable Object can drive any game the same way.

import {
  ELIMINATION_DEFAULTS,
  ELIMINATION_MIN_PLAYERS,
  clampEliminationSettings,
  eliminationView,
  startElimination,
  submitElimination,
  tickElimination,
  type EliminationSettings,
  type EliminationState,
  type EliminationView,
} from "./elimination";
import {
  RARITY_DEFAULTS,
  clampSettings as clampRaritySettings,
  rarityView,
  startRarity,
  submitRarity,
  tickRarity,
  type CategoryLookup,
  type PlayedAnswer,
  type RaritySettings,
  type RarityState,
  type RarityView,
  type RejectReason,
} from "./rarity";

export type GameMode = "rarity" | "elimination";
export type GameState = RarityState | EliminationState;
export type GameView = RarityView | EliminationView;

export interface GameSettings {
  rarity: RaritySettings;
  elimination: EliminationSettings;
}

export const DEFAULT_SETTINGS: GameSettings = { rarity: RARITY_DEFAULTS, elimination: ELIMINATION_DEFAULTS };

export const MIN_PLAYERS: Record<GameMode, number> = { rarity: 1, elimination: ELIMINATION_MIN_PLAYERS };

export type GameSubmitResult =
  | { ok: true; state: GameState; played: PlayedAnswer }
  | { ok: false; reason: RejectReason; taken?: string };

export function clampModeSettings(mode: GameMode, current: GameSettings, patch: Record<string, unknown>): GameSettings {
  if (mode === "rarity") return { ...current, rarity: clampRaritySettings({ ...current.rarity, ...patch }) };
  return { ...current, elimination: clampEliminationSettings({ ...current.elimination, ...patch }) };
}

// Rarity plays one category per round; Elimination may need more rounds than categories and cycles.
export function roundsNeeded(mode: GameMode, settings: GameSettings, playerCount: number): number {
  if (mode === "rarity") return settings.rarity.rounds;
  return settings.elimination.roundsToWin * Math.max(1, playerCount); // upper bound before someone wins
}

export function startGame(
  mode: GameMode,
  players: string[],
  categoryIds: string[],
  settings: GameSettings,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): GameState {
  if (mode === "rarity") return startRarity(players, categoryIds, settings.rarity, now, connected, lookup);
  return startElimination(players, categoryIds, settings.elimination, now, connected, lookup);
}

export function submitAnswer(
  state: GameState,
  playerId: string,
  text: string,
  now: number,
  connected: ReadonlySet<string>,
  lookup: CategoryLookup,
): GameSubmitResult {
  if (state.mode === "rarity") return submitRarity(state, playerId, text, now, connected, lookup);
  return submitElimination(state, playerId, text, now, connected, lookup);
}

export function tickGame(state: GameState, now: number, connected: ReadonlySet<string>, lookup: CategoryLookup): GameState {
  if (state.mode === "rarity") return tickRarity(state, now, connected, lookup);
  return tickElimination(state, now, connected, lookup);
}

export function viewGame(state: GameState, lookup: CategoryLookup): GameView {
  return state.mode === "rarity" ? rarityView(state, lookup) : eliminationView(state, lookup);
}

export function currentCategoryId(state: GameState): string {
  return state.categoryIds[state.round % state.categoryIds.length];
}
