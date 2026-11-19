import { describe, expect, it } from "vitest";
import { generateRoomCode, isValidRoomCode, normalizeRoomCode, validateNickname } from "./protocol";

describe("room codes", () => {
  it("generates valid 4-letter codes", () => {
    for (let i = 0; i < 200; i++) expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it("rejects ambiguous or wrong-length codes", () => {
    expect(isValidRoomCode("ABCD")).toBe(false); // A is a vowel, not in the alphabet
    expect(isValidRoomCode("BCD")).toBe(false);
    expect(isValidRoomCode("BCDFG")).toBe(false);
    expect(isValidRoomCode("BC0D")).toBe(false);
  });

  it("normalizes user input", () => {
    expect(normalizeRoomCode("  bcdf ")).toBe("BCDF");
  });
});

describe("nicknames", () => {
  it("trims and collapses whitespace", () => {
    expect(validateNickname("  Sam   Lee ")).toBe("Sam Lee");
  });

  it("enforces length", () => {
    expect(validateNickname("a")).toBeNull();
    expect(validateNickname("x".repeat(17))).toBeNull();
  });
});
