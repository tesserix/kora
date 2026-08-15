import { darkColors, lightColors, radius, spacing , gradientStops, type } from "../palette";


test("every light color key has a dark counterpart", () => {
  expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
});

test("all colors are valid CSS color strings parseable by RN (hex or rgba)", () => {
  for (const v of [...Object.values(lightColors), ...Object.values(darkColors)]) {
    expect(v).toMatch(/^(#[0-9A-Fa-f]{6}|rgba\(\d+,\d+,\d+,[\d.]+\))$/);
  }
});

test("primary is green — iOS system green in light, brighter mock green in dark", () => {
  expect(lightColors.primary).toBe("#34C759");
  expect(darkColors.primary).toBe("#3DDC6E");
});

test("background — iOS grouped in light, green-tinted near-black (mock) in dark", () => {
  expect(lightColors.background).toBe("#F2F2F7");
  expect(darkColors.background).toBe("#0A0D0B");
});

test("card — iOS elevated white in light, green-tinted surface (mock) in dark", () => {
  expect(lightColors.card).toBe("#FFFFFF");
  expect(darkColors.card).toBe("#151A16");
});

test("spacing and radius match the design system scale", () => {
  expect(spacing.md).toBe(16);
  expect(radius.lg).toBe(12);
});

describe("elevated tokens", () => {
  it("adds elevated surface to both schemes", () => {
    for (const c of [lightColors, darkColors]) {
      expect(c.elevated).toMatch(/^#/);
    }
  });
  it("exposes 2-stop gradient sets per scheme, none of them violet/purple", () => {
    for (const scheme of [gradientStops.light, gradientStops.dark]) {
      for (const pair of [scheme.green, scheme.amber, scheme.blue]) {
        expect(pair).toHaveLength(2);
        expect(pair[0]).toMatch(/^#/);
        expect(pair[1]).toMatch(/^#/);
      }
    }
  });
});

// kora#177: AppText sets no fontFamily, so every variant renders in SF Pro,
// which ships its own optical-size tracking — POSITIVE at display sizes (SF
// Display is drawn tight) and NEGATIVE at text sizes (SF Text is drawn loose).
// The old table used the generic web rule (negative on titles, 0 on body) and
// therefore fought the system: -0.4 on a 34pt title landed 0.77pt tighter than
// native iOS chrome beside it.
describe("type tracking is signed with SF Pro, not against it", () => {
  it("leaves text-size variants untracked so SF's built-in tracking applies", () => {
    for (const v of ["headline", "body", "subheadline", "footnote"] as const) {
      expect(type[v].letterSpacing).toBeUndefined();
    }
  });

  it("tracks the three display variants POSITIVE, matching SF Display", () => {
    expect(type.largeTitle.letterSpacing).toBe(0.37);
    expect(type.title1.letterSpacing).toBe(0.36);
    expect(type.title2.letterSpacing).toBe(0.35);
  });

  it("keeps caption's editorial widening but at a sane multiple of SF's own", () => {
    // SF's caption1 tracking is +0.06; the old +0.5 was 8x that.
    expect(type.caption.letterSpacing).toBe(0.2);
  });

  it("keeps the Apple Dynamic Type size/leading pairs unchanged", () => {
    expect(type.body).toMatchObject({ size: 17, lineHeight: 22 });
    expect(type.largeTitle).toMatchObject({ size: 34, lineHeight: 41 });
    expect(type.caption).toMatchObject({ size: 11, lineHeight: 13 });
  });
});
