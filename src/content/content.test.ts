import { describe, expect, it } from "vitest";
import { answerId, normalize } from "../shared/matcher";
import { CATEGORIES } from "./index";

describe("category content", () => {
  it("has unique category ids", () => {
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const category of CATEGORIES) {
    describe(category.id, () => {
      it("has a prompt and at least 40 answers", () => {
        expect(category.prompt.trim()).not.toBe("");
        expect(category.answers.length).toBeGreaterThanOrEqual(40);
      });

      it("uses tiers 1-5, each at least 4 times", () => {
        const counts = [0, 0, 0, 0, 0];
        for (const a of category.answers) {
          expect([1, 2, 3, 4, 5]).toContain(a.tier);
          counts[a.tier - 1]++;
        }
        for (const n of counts) expect(n).toBeGreaterThanOrEqual(4);
      });

      it("never maps one spelling to two different answers", () => {
        const owner = new Map<string, string>();
        const clashes: string[] = [];
        for (const a of category.answers) {
          const id = answerId(a);
          for (const raw of [a.canonical, ...(a.aliases ?? [])]) {
            const key = normalize(raw);
            expect(key).not.toBe("");
            const prev = owner.get(key);
            if (prev && prev !== id) clashes.push(`"${raw}" -> ${prev} and ${id}`);
            owner.set(key, id);
          }
        }
        expect(clashes).toEqual([]);
      });
    });
  }
});
