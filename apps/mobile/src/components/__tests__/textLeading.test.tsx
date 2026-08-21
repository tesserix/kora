import type { ReactElement } from "react";
import { PixelRatio, StyleSheet } from "react-native";
import { render } from "@testing-library/react-native";
import { AppText } from "../Text";
import { Numeral } from "../Numeral";
import { type as typeScale } from "@/theme/palette";

// ---------------------------------------------------------------------------
// WHAT THESE TESTS CAN AND CANNOT SEE
//
// They assert the `lineHeight` NUMBER AppText puts on the style object. They do
// NOT verify the rendered line box, and they cannot: jest renders no platform
// text engine, so the Dynamic Type scaling that iOS applies to `lineHeight` is
// invisible here — the same blind spot as `useAnimatedStyle` in kora#257.
//
// That blind spot has already cost one shipped bug. These five tests previously
// asserted that AppText multiplies its line box by `PixelRatio.getFontScale()`,
// and they passed, green, for the entire life of kora#173 — while the platform
// was applying that same scale a second time and blowing the rendered box out to
// scale². 1,729 green tests did not notice two blank lines between "Welcome"
// and "back.".
//
// So: the contract below is the JS-side contract only. The rendered result is
// verified by simulator screenshot at `medium` and at
// `accessibility-extra-large`, and by the measurements recorded in
// .planning/debug/resolved/lineheight-double-scaled.md. Anything you want to
// claim about the rendered box has to be measured on a device.
// ---------------------------------------------------------------------------

function leading(style: unknown): { fontSize: number; lineHeight: number } {
  const flat = StyleSheet.flatten(style as never) as { fontSize: number; lineHeight: number };
  return { fontSize: flat.fontSize, lineHeight: flat.lineHeight };
}

describe("AppText leading follows the effective font size", () => {
  it.each([
    // [effective size, expected line height, ratio band]
    [10, 15], // 1.45 — dense label; was 22 (ratio 2.2)
    [13, 19], // 1.45
    [16, 21], // 1.30
    [22, 27], // 1.22 — was 22 (ratio 1.0; ascenders touched descenders)
    [34, 39], // 1.15
    [54, 62], // 1.15 — was a 22pt box that clipped the glyph
  ])("size %i gets a %ipt line box", async (size, expected) => {
    const { getByText } = await render(<AppText style={{ fontSize: size }}>42</AppText>);
    expect(leading(getByText("42").props.style)).toEqual({ fontSize: size, lineHeight: expected });
  });

  it("lets an explicit caller lineHeight win over the derived one", async () => {
    const { getByText } = await render(
      <AppText style={{ fontSize: 34, lineHeight: 30 }}>42</AppText>,
    );
    expect(leading(getByText("42").props.style).lineHeight).toBe(30);
  });

  it("keeps every variant's own Apple line height when the size is not overridden", async () => {
    for (const [name, spec] of Object.entries(typeScale)) {
      const { getByText } = await render(
        <AppText variant={name as keyof typeof typeScale}>{name}</AppText>,
      );
      expect(leading(getByText(name).props.style)).toEqual({
        fontSize: spec.size,
        lineHeight: spec.lineHeight,
      });
    }
  });

  it("derives leading for a variant whose size the caller overrides", async () => {
    // body (17/22) forced to 54 must not keep the 22pt box.
    const { getByText } = await render(
      <AppText variant="body" style={{ fontSize: 54 }}>
        big
      </AppText>,
    );
    expect(leading(getByText("big").props.style).lineHeight).toBe(62);
  });
});

describe("Numeral no longer needs its own leading workaround", () => {
  it("gets size-derived leading from AppText", async () => {
    const { getByText } = await render(<Numeral size={54}>0</Numeral>);
    expect(leading(getByText("0").props.style)).toEqual({ fontSize: 54, lineHeight: 62 });
  });

  it("still honours an explicit lineHeight from its caller", async () => {
    const { getByText } = await render(
      <Numeral size={24} style={{ lineHeight: 40 }}>
        7
      </Numeral>,
    );
    expect(leading(getByText("7").props.style).lineHeight).toBe(40);
  });
});

// The platform scales `lineHeight` for Dynamic Type by exactly the same factor
// it scales `fontSize`. Measured on RN 0.86 / New Architecture, iPhone 17 Pro
// Max: a sweep of fifteen lineHeight values from 10 to 80 at fontScale 2.6430
// produced a rendered per-line advance of 2.633–2.650x the authored value in
// every case, and exactly 1.000x under `allowFontScaling={false}` (kora#173).
//
// AppText therefore emits UNSCALED points and lets the platform apply the scale
// once. These tests pin the absence of a second application: whatever the device
// font scale is, the emitted number must not move. They pass a mocked scale that
// a jest run would otherwise never exercise — RN's preset resolves
// PixelRatio.getFontScale() to the mocked pixel ratio (2), not to 1 — precisely
// so a reintroduced multiplication fails here instead of on a user's phone.
describe("leading is emitted unscaled — the platform applies Dynamic Type", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([1, 2, 2.643, 3.571])(
    "emits the same derived box at font scale %p",
    async (scale) => {
      jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(scale);
      const { getByText } = await render(<AppText style={{ fontSize: 15 }}>hi</AppText>);
      // 15 * 1.3 = 19.5 -> 20. Not 20 * scale: the platform does that part.
      expect(leading(getByText("hi").props.style).lineHeight).toBe(20);
    },
  );

  it("emits a variant's own Apple line box unscaled", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2.643);
    const { getByText } = await render(<AppText variant="body">hi</AppText>);
    expect(leading(getByText("hi").props.style).lineHeight).toBe(typeScale.body.lineHeight);
  });

  // `allowFontScaling={false}` needs no special case: the platform multiplies
  // the box by 1 when scaling is off, so the authored ratio already survives.
  // Measured: lineHeight 26 with scaling off renders at exactly 26.00pt while
  // fontScale is 2.6430.
  it("emits the same box when the caller turns glyph scaling off", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2.643);
    const { getByText } = await render(
      <AppText allowFontScaling={false} style={{ fontSize: 15 }}>
        hi
      </AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(20);
  });

  // `maxFontSizeMultiplier` needs no special case either. It caps the glyph and
  // the RENDERED box by the same capped multiplier, so the ratio holds. (RN does
  // over-reserve LAYOUT height for capped text — measured 68.67pt for a box that
  // renders at 39pt — but that is an RN measure/render disagreement, and
  // pre-scaling here would corrupt the rendered result while not fixing it.)
  it("emits the same box when the caller caps the multiplier", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(3);
    const { getByText } = await render(
      <AppText maxFontSizeMultiplier={1.5} style={{ fontSize: 15 }}>
        hi
      </AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(20);
  });

  it("leaves an explicit caller lineHeight alone", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2.643);
    const { getByText } = await render(
      <AppText style={{ fontSize: 64, lineHeight: 72 }}>hi</AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(72);
  });
});

// ---------------------------------------------------------------------------
// The steps kora#237 added: title3, callout, caption2, numeral1, numeral2.
//
// The "every variant" test above already pins their size/leading, because it
// iterates the table. What it does NOT pin is that they behave IDENTICALLY in
// the rest of AppText's machinery — the derived-leading escape hatch, the
// maxFontSizeMultiplier ceiling, and the caller-override precedence. Three of
// the five have an authored leading that DISAGREES with the derived ratio, so
// the two paths producing different numbers for the same variant is a real
// failure mode rather than a theoretical one.
//
// Same blind spot as the header of this file: these read the emitted style
// object. They prove the numbers AppText hands React Native. They prove nothing
// about a glyph on a screen.
// ---------------------------------------------------------------------------
describe("the kora#237 steps behave like the eight that were already there", () => {
  it.each([
    // [variant, size, authored leading, what the derived ratio would give]
    ["numeral1", 64, 72, 74],
    ["numeral2", 44, 50, 51],
    ["title3", 20, 25, 24],
    ["callout", 16, 21, 21],
    ["caption2", 9, 12, 13],
  ] as const)(
    "%s renders %ipt on a %ipt box, not the derived %ipt",
    async (variant, size, authored, _derived) => {
      const { getByText } = await render(<AppText variant={variant}>{variant}</AppText>);
      expect(leading(getByText(variant).props.style)).toEqual({ fontSize: size, lineHeight: authored });
    },
  );

  it.each([
    // A caller who overrides the size gets the RATIO box, not the step's own —
    // exactly as body does. Pinned per band because each new step sits in a
    // different one.
    ["numeral1", 26, 32], // 1.22
    ["title3", 12, 17], // 1.45
    ["callout", 40, 46], // 1.15
    ["caption2", 24, 29], // 1.22
  ] as const)("%s at an overridden %ipt falls back to the derived %ipt", async (variant, size, expected) => {
    const { getByText } = await render(
      <AppText variant={variant} style={{ fontSize: size }}>
        over
      </AppText>,
    );
    expect(leading(getByText("over").props.style)).toEqual({ fontSize: size, lineHeight: expected });
  });

  it("carries no Dynamic Type ceiling — largeTitle is still the only variant with one", async () => {
    for (const variant of ["numeral1", "numeral2", "title3", "callout", "caption2"] as const) {
      const { getByText } = await render(<AppText variant={variant}>{variant}</AppText>);
      expect(getByText(variant).props.maxFontSizeMultiplier).toBeUndefined();
    }
    const { getByText } = await render(<AppText variant="largeTitle">big</AppText>);
    expect(getByText("big").props.maxFontSizeMultiplier).toBe(typeScale.largeTitle.maxScale);
  });

  it("still lets an explicit caller maxFontSizeMultiplier win", async () => {
    const { getByText } = await render(
      <AppText variant="numeral2" maxFontSizeMultiplier={1.4}>
        44
      </AppText>,
    );
    expect(getByText("44").props.maxFontSizeMultiplier).toBe(1.4);
  });

  it("emits the added steps' boxes unscaled, like every other variant", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2.643);
    try {
      for (const variant of ["numeral1", "title3", "callout", "caption2"] as const) {
        const { getByText } = await render(<AppText variant={variant}>{variant}</AppText>);
        expect(leading(getByText(variant).props.style).lineHeight).toBe(typeScale[variant].lineHeight);
      }
    } finally {
      jest.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// Which variants a raw `fontSize` literal can be migrated to WITHOUT moving a
// pixel (kora#237 §2).
//
// A raw literal renders through derivedLeading(); a variant renders through its
// own authored lineHeight. Those two numbers agree for some steps and disagree
// for others, so "replace fontSize: N with variant=X" is only a no-op for the
// ones where they agree AND the variant adds no tracking of its own. The
// call-site sweep was scoped to exactly that set; footnote (13 -> authored 18 vs
// derived 19) and caption (11, plus +0.2 tracking) were deliberately left with
// their literals rather than shipped as a silent 1pt reflow across ~68 sites.
//
// This is a JS-side equality, not a visual one — see the header. It says the
// two paths emit the same numbers, which is the strongest claim jest can make.
// ---------------------------------------------------------------------------
describe("the variants the call-site sweep migrated to are byte-identical to the literal", () => {
  async function emitted(node: ReactElement, text: string) {
    const { getByText } = await render(node);
    const flat = StyleSheet.flatten(getByText(text).props.style as never) as Record<string, unknown>;
    return {
      fontSize: flat.fontSize,
      lineHeight: flat.lineHeight,
      fontWeight: flat.fontWeight,
      letterSpacing: flat.letterSpacing,
    };
  }

  it.each([
    ["subheadline", 15, "400"],
    ["headline", 17, "600"],
    ["callout", 16, "400"],
  ] as const)("%s matches a bare fontSize: %i at weight %s", async (variant, size, weight) => {
    const asLiteral = await emitted(<AppText style={{ fontSize: size, fontWeight: weight }}>x</AppText>, "x");
    const asVariant = await emitted(<AppText variant={variant}>x</AppText>, "x");
    expect(asVariant).toEqual(asLiteral);
  });

  it.each([
    // Left OUT of the sweep, and this is why: the variant's box is not the
    // derived box, so migrating these WOULD change the rendered line.
    ["footnote", 13],
    ["caption", 11],
    ["caption2", 9],
    ["title3", 20],
  ] as const)("%s is NOT interchangeable with a bare fontSize: %i", async (variant, size) => {
    const asLiteral = await emitted(<AppText style={{ fontSize: size }}>x</AppText>, "x");
    const asVariant = await emitted(<AppText variant={variant}>x</AppText>, "x");
    expect(asVariant.fontSize).toBe(asLiteral.fontSize);
    expect([asVariant.lineHeight, asVariant.letterSpacing]).not.toEqual([
      asLiteral.lineHeight,
      asLiteral.letterSpacing,
    ]);
  });
});
