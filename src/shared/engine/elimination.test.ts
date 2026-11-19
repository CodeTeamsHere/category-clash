import { describe, expect, it } from "vitest";
import type { Category } from "../category";
import {
  MIN_TURN_SECONDS,
  alivePlayers,
  clampEliminationSettings,
  startElimination,
  submitElimination,
  tickElimination,
  type EliminationState,
} from "./elimination";
import { ROUND_END_MS } from "./rarity";

const fruit: Category = {
  id: "fruit",
  prompt: "A fruit",
  answers: ["Apple", "Banana", "Cherry", "Durian", "Fig", "Grape", "Kiwi", "Lemon", "Mango"].map((canonical, i) => ({
    canonical,
    tier: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
  })),
};
const color: Category = { id: "color", prompt: "A color", answers: [{ canonical: "Red", tier: 1 }] };
const lookup = (id: string) => ({ fruit, color })[id as "fruit" | "color"];

const T0 = 1_000_000;
const settings = { lives: 2, startSeconds: 8, roundsToWin: 2 };
const abc = new Set(["a", "b", "c"]);

function start(connected: ReadonlySet<string> = abc, players = ["a", "b", "c"]): EliminationState {
  return startElimination(players, ["fruit", "color"], settings, T0, connected, lookup);
}

function ok(r: ReturnType<typeof submitElimination>): EliminationState {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.state;
}

function timeout(s: EliminationState, connected: ReadonlySet<string> = abc): EliminationState {
  return tickElimination(s, s.deadline, connected, lookup);
}

describe("elimination engine", () => {
  it("needs two players", () => {
    expect(() => start(new Set(["a"]), ["a"])).toThrow();
  });

  it("starts with full lives on the first seat", () => {
    const s = start();
    expect(s.current).toBe("a");
    expect(s.lives).toEqual({ a: 2, b: 2, c: 2 });
    expect(s.deadline).toBe(T0 + 8000);
  });

  it("passes the turn on a valid answer and rejects repeats and unknowns without penalty", () => {
    let s = start();
    expect(submitElimination(s, "a", "carrot", T0, abc, lookup)).toEqual({ ok: false, reason: "not_in_list" });
    s = ok(submitElimination(s, "a", "apple", T0, abc, lookup));
    expect(s.current).toBe("b");
    expect(submitElimination(s, "b", "apples", T0, abc, lookup)).toEqual({ ok: false, reason: "taken", taken: "Apple" });
    expect(s.lives).toEqual({ a: 2, b: 2, c: 2 });
  });

  it("costs a life on timeout and moves on", () => {
    const s = timeout(start());
    expect(s.lives.a).toBe(1);
    expect(s.current).toBe("b");
    expect(s.turns.at(-1)).toEqual({ playerId: "a", result: "timeout", livesLeft: 1 });
  });

  it("shrinks the timer each lap down to the minimum", () => {
    let s = start();
    const answers = ["apple", "banana", "cherry", "durian", "fig", "grape", "kiwi", "lemon", "mango"];
    const lengths: number[] = [];
    for (const word of answers) {
      lengths.push(s.turnMs);
      s = ok(submitElimination(s, s.current!, word, T0, abc, lookup));
    }
    expect(lengths.slice(0, 3)).toEqual([8000, 8000, 8000]);
    expect(lengths.slice(3, 6)).toEqual([7000, 7000, 7000]);
    expect(lengths.slice(6, 9)).toEqual([6000, 6000, 6000]);

    const fast = startElimination(["a", "b"], ["fruit"], { ...settings, startSeconds: 6 }, T0, abc, lookup);
    let f = fast;
    for (const word of answers.slice(0, 8)) f = ok(submitElimination(f, f.current!, word, T0, abc, lookup));
    expect(f.turnMs).toBe(MIN_TURN_SECONDS * 1000);
  });

  it("skips eliminated players", () => {
    let s = start();
    s = timeout(s); // a: 1
    s = ok(submitElimination(s, "b", "apple", T0, abc, lookup));
    s = ok(submitElimination(s, "c", "banana", T0, abc, lookup));
    s = timeout(s); // a: 0, out
    expect(alivePlayers(s)).toEqual(["b", "c"]);
    expect(s.current).toBe("b");
    s = ok(submitElimination(s, "b", "cherry", T0, abc, lookup));
    expect(s.current).toBe("c");
    s = ok(submitElimination(s, "c", "durian", T0, abc, lookup));
    expect(s.current).toBe("b");
  });

  it("ends the round with one survivor, then starts the next with reset lives and the next opener", () => {
    let s = start(new Set(["a", "b"]), ["a", "b"]);
    s = timeout(s, new Set(["a", "b"])); // a: 1, b's turn
    s = ok(submitElimination(s, "b", "apple", T0, new Set(["a", "b"]), lookup));
    s = timeout(s, new Set(["a", "b"])); // a: 0 -> b wins
    expect(s.phase).toBe("round_end");
    expect(s.roundWinner).toBe("b");
    expect(s.wins).toEqual({ a: 0, b: 1 });
    expect(s.matchWinner).toBeNull();
    expect(s.roundSummaries[0]).toMatchObject({ prompt: "A fruit", winnerId: "b", answers: 1 });

    const next = tickElimination(s, s.deadline, new Set(["a", "b"]), lookup);
    expect(next.round).toBe(1);
    expect(next.phase).toBe("turn");
    expect(next.lives).toEqual({ a: 2, b: 2 });
    expect(next.current).toBe("b");
    expect(next.usedAnswerIds).toEqual([]);
  });

  it("ends the match when someone reaches roundsToWin", () => {
    const both = new Set(["a", "b"]);
    let s = startElimination(["a", "b"], ["fruit", "color"], { ...settings, lives: 1, roundsToWin: 1 }, T0, both, lookup);
    s = timeout(s, both); // a out -> b wins match
    expect(s.matchWinner).toBe("b");
    expect(s.deadline).toBe(T0 + 8000 + ROUND_END_MS);
    s = timeout(s, both);
    expect(s.phase).toBe("game_over");
  });

  it("disconnected players lose a life on their turn instead of stalling", () => {
    const s = start(new Set(["b", "c"]));
    expect(s.lives.a).toBe(1);
    expect(s.turns[0]).toEqual({ playerId: "a", result: "skipped", livesLeft: 1 });
    expect(s.current).toBe("b");
  });

  it("drains disconnected players until the last connected one wins", () => {
    const onlyC = new Set(["c"]);
    let s = start(onlyC);
    expect(s.lives).toEqual({ a: 1, b: 1, c: 2 });
    expect(s.current).toBe("c");
    s = ok(submitElimination(s, "c", "apple", T0, onlyC, lookup));
    expect(s.phase).toBe("round_end");
    expect(s.roundWinner).toBe("c");
  });

  it("clamps settings", () => {
    expect(clampEliminationSettings({ lives: 0, startSeconds: 100, roundsToWin: Number.NaN })).toEqual({
      lives: 1,
      startSeconds: 30,
      roundsToWin: 2,
    });
  });
});
