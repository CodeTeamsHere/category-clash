import { describe, expect, it } from "vitest";
import type { Category } from "./category";
import { levenshtein, matchAnswer, normalize } from "./matcher";

const cat: Category = {
  id: "test",
  prompt: "Test",
  answers: [
    { canonical: "Ivory Coast", aliases: ["Côte d'Ivoire"], tier: 3 },
    { canonical: "Strawberry", tier: 1 },
    { canonical: "Cherry", tier: 2 },
    { canonical: "Austria", tier: 2 },
    { canonical: "Australia", tier: 2 },
    { canonical: "The Gambia", tier: 4 },
    { canonical: "Mali", tier: 3 },
    { canonical: "Bali", tier: 3 },
  ],
};

describe("normalize", () => {
  it("lowercases, strips accents, punctuation and leading articles", () => {
    expect(normalize("  Côte d'Ivoire! ")).toBe("cote divoire");
    expect(normalize("The Gambia")).toBe("gambia");
    expect(normalize("Salt & Pepper")).toBe("salt and pepper");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
});

describe("matchAnswer", () => {
  const id = (input: string) => matchAnswer(cat, input)?.id ?? null;

  it("matches canonical, alias and case-insensitive input", () => {
    expect(id("ivory coast")).toBe("ivory coast");
    expect(id("Cote d'Ivoire")).toBe("ivory coast");
    expect(id("GAMBIA")).toBe("gambia");
  });

  it("matches plurals", () => {
    expect(id("strawberries")).toBe("strawberry");
    expect(id("cherries")).toBe("cherry");
  });

  it("accepts a single typo on longer words", () => {
    expect(id("strawbery")).toBe("strawberry");
    expect(id("Austira")).toBeNull(); // transposition = 2 edits
    expect(id("Austrria")).toBe("austria");
  });

  it("accepts a typo combined with a plural", () => {
    expect(id("strawbery")).toBe("strawberry");
    expect(id("strawberys")).toBe("strawberry");
    expect(id("cheries")).toBe("cherry");
  });

  it("does not fuzz short words", () => {
    expect(id("Mali")).toBe("mali");
    expect(id("Malo")).toBeNull();
  });

  it("rejects unrelated input", () => {
    expect(id("banana")).toBeNull();
    expect(id("")).toBeNull();
    expect(id("!!!")).toBeNull();
  });
});
