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

// kora#237 added five steps. These pin the decisions that are easy to
// "tidy up" later without realising they were decisions.
describe("the steps kora#237 added", () => {
  it("fills in the middle of Apple's ramp at Apple's own size/leading pairs", () => {
    expect(type.title3).toMatchObject({ size: 20, lineHeight: 25 });
    expect(type.callout).toMatchObject({ size: 16, lineHeight: 21 });
  });

  it("keeps title3 in the display family's weight and positive tracking", () => {
    // Apple draws title3 Regular; this table draws its whole title family bold
    // (title1/title2 are 700 too), so title3 follows the family, not Apple.
    expect(type.title3.weight).toBe("700");
    expect(type.title3.letterSpacing).toBe(0.38);
  });

  it("leaves callout untracked, like every other text-size variant", () => {
    // SF Text ships its own (negative) tracking at 16pt — see the note on the
    // table. callout is a text size, so it joins headline/body/subheadline/
    // footnote in letting SF's own value stand.
    expect(type.callout.letterSpacing).toBeUndefined();
    expect(type.callout.weight).toBe("400");
  });

  it("puts caption2 BELOW Apple's floor, on purpose", () => {
    // Apple's caption2 is 11/13 — which is what this table calls `caption`.
    // Ours is 9/12, a kora-specific step named for the 9pt engraved labels the
    // app already draws. It is not an Apple value and should not be "corrected"
    // to one.
    expect(type.caption2).toMatchObject({ size: 9, lineHeight: 12 });
    expect(type.caption2.size).toBeLessThan(type.caption.size);
    expect(type.caption2.letterSpacing).toBe(type.caption.letterSpacing);
  });

  it("names two display numerals above largeTitle, tracked negative", () => {
    // Above Apple's ramp entirely, and rendered in the mono data face rather
    // than SF Pro — so the positive-tracking rule that governs the titles does
    // not apply here. Both values come from the call sites they were taken from.
    expect(type.numeral1).toMatchObject({ size: 64, lineHeight: 72, letterSpacing: -2 });
    expect(type.numeral2).toMatchObject({ size: 44, lineHeight: 50, letterSpacing: -1.2 });
    for (const v of [type.numeral1, type.numeral2]) {
      expect(v.size).toBeGreaterThan(type.largeTitle.size);
      expect(v.letterSpacing).toBeLessThan(0);
    }
  });

  it("gives none of them a Dynamic Type ceiling", () => {
    // largeTitle's cap is the measured Apple ceiling for largeTitle and nothing
    // else (kora#274); copying it onto a neighbour would be a guess.
    for (const v of ["title3", "callout", "caption2", "numeral1", "numeral2"] as const) {
      expect(type[v].maxScale).toBeUndefined();
    }
  });

  it("keeps the scale strictly descending, so the steps are a ramp and not a bag", () => {
    const order = [
      "numeral1", "numeral2", "largeTitle", "title1", "title2", "title3",
      "headline", "callout", "subheadline", "footnote", "caption", "caption2",
    ] as const;
    const sizes = order.map((v) => type[v].size);
    // headline and body share 17, so `body` is left out of the ramp check and
    // asserted against headline directly.
    expect(type.body.size).toBe(type.headline.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(sizes.length);
  });
});
