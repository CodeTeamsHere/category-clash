import { describe, expect, it } from "vitest";
import type { Category } from "../category";
import {
  ROUND_END_MS,
  clampSettings,
  currentPlayer,
  startRarity,
  submitRarity,
  tickRarity,
  type RarityState,
} from "./rarity";

const fruit: Category = {
  id: "fruit",
  prompt: "A fruit",
  answers: [
    { canonical: "Apple", tier: 1 },
    { canonical: "Banana", tier: 1 },
    { canonical: "Durian", tier: 5 },
    { canonical: "Fig", tier: 3 },
  ],
};
const color: Category = { id: "color", prompt: "A color", answers: [{ canonical: "Red", tier: 1 }] };
const lookup = (id: string) => ({ fruit, color })[id as "fruit" | "color"];

const settings = { rounds: 2, turnsPerPlayer: 1, turnSeconds: 10 };
const all = new Set(["a", "b"]);
const T0 = 1_000_000;

function start(connected: ReadonlySet<string> = all): RarityState {
  return startRarity(["a", "b"], ["fruit", "color"], settings, T0, connected, lookup);
}

function submit(state: RarityState, player: string, text: string, now = T0 + 1000) {
  return submitRarity(state, player, text, now, all, lookup);
}

describe("rarity engine", () => {
  it("starts on the first player's turn with zero scores", () => {
    const s = start();
    expect(s.phase).toBe("turn");
    expect(currentPlayer(s)).toBe("a");
    expect(s.deadline).toBe(T0 + 10_000);
    expect(s.scores).toEqual({ a: 0, b: 0 });
  });

  it("scores a valid answer by tier and passes the turn", () => {
    const r = submit(start(), "a", "durian");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.played.points).toBe(100);
    expect(r.state.scores.a).toBe(100);
    expect(currentPlayer(r.state)).toBe("b");
  });

  it("rejects out-of-turn, unknown and repeated answers without passing the turn", () => {
    const s = start();
    expect(submit(s, "b", "apple")).toEqual({ ok: false, reason: "not_your_turn" });
    expect(submit(s, "a", "carrot")).toEqual({ ok: false, reason: "not_in_list" });

    const r = submit(s, "a", "apple");
    if (!r.ok) throw new Error("expected ok");
    expect(submit(r.state, "b", "Apples")).toEqual({ ok: false, reason: "taken", taken: "Apple" });
    expect(currentPlayer(r.state)).toBe("b");
  });

  it("rejects answers after the deadline", () => {
    expect(submit(start(), "a", "apple", T0 + 10_001)).toEqual({ ok: false, reason: "time_up" });
  });

  it("times out a turn when the deadline passes", () => {
    const s = start();
    expect(tickRarity(s, T0 + 5000, all, lookup)).toBe(s); // too early: unchanged
    const t = tickRarity(s, T0 + 10_000, all, lookup);
    expect(t.turns).toEqual([{ playerId: "a", result: "timeout" }]);
    expect(currentPlayer(t)).toBe("b");
  });

  it("ends the round, records the best answer, then starts the next round with rotated order", () => {
    let s = start();
    let r = submit(s, "a", "fig");
    if (!r.ok) throw new Error();
    r = submit(r.state, "b", "durian", T0 + 2000);
    if (!r.ok) throw new Error();
    s = r.state;

    expect(s.phase).toBe("round_end");
    expect(s.deadline).toBe(T0 + 2000 + ROUND_END_MS);
    expect(s.roundSummaries[0].best).toMatchObject({ playerId: "b", played: { answer: "Durian" } });

    s = tickRarity(s, s.deadline, all, lookup);
    expect(s.round).toBe(1);
    expect(s.phase).toBe("turn");
    expect(s.turnOrder).toEqual(["b", "a"]);
    expect(s.usedAnswerIds).toEqual([]);
    expect(s.scores).toEqual({ a: 40, b: 100 });
  });

  it("ends the game after the last round", () => {
    let s = start();
    // Let every turn and intermission time out.
    for (let i = 0; i < 20 && s.phase !== "game_over"; i++) s = tickRarity(s, s.deadline, all, lookup);
    expect(s.phase).toBe("game_over");
    expect(s.roundSummaries).toHaveLength(2);
  });

  it("skips disconnected players", () => {
    const s = start(new Set(["b"]));
    expect(s.turns).toEqual([{ playerId: "a", result: "skipped" }]);
    expect(currentPlayer(s)).toBe("b");
  });

  it("ends the round immediately when nobody is connected", () => {
    const s = start(new Set());
    expect(s.phase).toBe("round_end");
  });

  it("clamps settings", () => {
    expect(clampSettings({ rounds: 99, turnSeconds: 1, turnsPerPlayer: NaN })).toEqual({
      rounds: 10,
      turnSeconds: 5,
      turnsPerPlayer: 2,
    });
  });
});
