import { initials } from "../initials";

// kora#454: one shared initials() for every Avatar chip. First+last initial,
// chosen because it is what LookupResultCard already shipped and matches what
// people expect for a multi-word name.
describe("initials", () => {
  test("first + last initial for a multi-word name", () => {
    expect(initials("Ada Grace Lovelace")).toBe("AL");
  });

  test("first + second initial for a two-word name", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  test("just the first letter for a single-word name", () => {
    expect(initials("Ada")).toBe("A");
  });

  test("empty string for an empty name, never a letter", () => {
    expect(initials("")).toBe("");
  });

  test("empty string for undefined", () => {
    expect(initials(undefined)).toBe("");
  });

  test("empty string for null", () => {
    expect(initials(null)).toBe("");
  });

  test("empty string for a whitespace-only name", () => {
    expect(initials("   ")).toBe("");
  });

  test("trims leading and trailing whitespace", () => {
    expect(initials("  Ada Lovelace  ")).toBe("AL");
  });

  test("collapses multiple spaces between words", () => {
    expect(initials("Ada    Lovelace")).toBe("AL");
  });

  test("uppercases lowercase names", () => {
    expect(initials("ada lovelace")).toBe("AL");
  });
});
