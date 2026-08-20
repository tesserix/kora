import {
  captionFitsInFace,
  GAUGE_VIEW_W,
  INSTRUMENT_SCALE_MAX,
  instrumentScale,
  overlayBudget,
  overlayStack,
} from "../gauge";

describe("instrumentScale", () => {
  it("is exactly 1 at the default content size, at every width", () => {
    // The byte-identical-at-`medium` property: this is what lets the existing
    // goldens at the default content size stand unchanged.
    for (const width of [0, 320, 393, 430, 1024, Number.POSITIVE_INFINITY]) {
      expect(instrumentScale(1, width)).toBe(1);
    }
  });

  it("never shrinks the dial below the design for a user who shrank their text", () => {
    expect(instrumentScale(0.8, 393)).toBe(1);
    expect(instrumentScale(0.5, 1024)).toBe(1);
  });

  it("returns the unclamped want when the width has not resolved (kora#270)", () => {
    // The kora#270 failure mode: a dimension resolving to 0 on an early frame
    // and the collapsed result reading as deliberate whitespace forever. These
    // must return the want, NOT 0 and NOT a floor of 1 imposed by a bad width.
    expect(instrumentScale(2, 0)).toBe(INSTRUMENT_SCALE_MAX);
    expect(instrumentScale(2, Number.NaN)).toBe(INSTRUMENT_SCALE_MAX);
    expect(instrumentScale(2, -10)).toBe(INSTRUMENT_SCALE_MAX);
    expect(instrumentScale(1.2, 0)).toBeCloseTo(1.2, 10);
  });

  it("caps at INSTRUMENT_SCALE_MAX when width is not the binding constraint", () => {
    expect(instrumentScale(3, 1024)).toBe(INSTRUMENT_SCALE_MAX);
    expect(instrumentScale(1.3, 1024)).toBeCloseTo(1.3, 10);
  });

  it("lets WIDTH bind first on the narrowest supported screen", () => {
    // 264 * 1.6 = 422.4pt of face against a 393pt screen, so the width clamp,
    // not the 1.6 ceiling, is what a 393pt device actually hits.
    expect(instrumentScale(1.6, 393)).toBeCloseTo(393 / GAUGE_VIEW_W, 10);
    expect(instrumentScale(1.6, 393)).toBeCloseTo(1.4886, 4);
    expect(instrumentScale(1.6, 393)).toBeLessThan(INSTRUMENT_SCALE_MAX);
  });
});

describe("centre-overlay fit", () => {
  it("reproduces kora#268's device measurement of the overlay budget", () => {
    // Cross-checks a measurement recorded in kora#268: overlay top 67.6pt and
    // hub-dot top 141.5pt on device, i.e. 73.9pt of room. If GAUGE_CENTER_Y,
    // HUB_DOT_R or the 38% inset changes, this failing is the signal that the
    // recorded device measurement is now stale — not that the formula is wrong.
    expect(overlayBudget(1)).toBeCloseTo(73.9, 1);
  });

  it("has about a point of slack at design size", () => {
    expect(overlayStack(1)).toBeCloseTo(73.0, 1);
    expect(overlayBudget(1) - overlayStack(1)).toBeCloseTo(0.86, 2);
    expect(captionFitsInFace(1, 1)).toBe(true);
  });

  it("grows the budget faster than the stack once the face scales with the text", () => {
    // The table in the plan, at an unconstrained width.
    expect(overlayBudget(1.4)).toBeCloseTo(103.4, 1);
    expect(overlayStack(1.4)).toBeCloseTo(99.8, 1);
    expect(overlayBudget(1.6)).toBeCloseTo(118.2, 1);
    expect(overlayStack(1.6)).toBeCloseTo(109.8, 1);
    expect(captionFitsInFace(instrumentScale(1.6, 1024), 1.6)).toBe(true);
  });

  it("caps the stack with its own maxFontSizeMultipliers", () => {
    expect(overlayStack(3)).toBeCloseTo(overlayStack(1.6), 10);
    expect(overlayStack(0.8)).toBeCloseTo(overlayStack(1), 10);
  });

  it("clears the caption by 0.15pt at a full 393pt width — which is why the ejection path exists", () => {
    // This is the width-clamp collision kora#268 describes. At the raw screen
    // width it survives by 0.15pt out of 110 — a margin thinner than a single
    // point of the estimate in CAPTION_LINE_RATIO — and the break-even width is
    // 392.5pt, so ANY horizontal padding on the screen tips it negative. The
    // plan predicted an outright false here off a mis-derived s = 1.34; the
    // arithmetic gives s = 393/264 = 1.4886 and a hairline true. Either way the
    // caption cannot be relied on to fit at 1.6 on a 393pt device, which is the
    // whole reason GaugeDial needs a caption-ejection path rather than a
    // bigger face.
    const s = instrumentScale(1.6, 393);
    expect(overlayBudget(s) - overlayStack(1.6)).toBeCloseTo(0.15, 2);
    expect(captionFitsInFace(s, 1.6)).toBe(true);
  });

  it("ejects the caption once the screen has any padding at all", () => {
    // 20pt of padding each side of a 393pt screen — the realistic case.
    const s = instrumentScale(1.6, 393 - 40);
    expect(s).toBeCloseTo(1.3371, 4);
    expect(captionFitsInFace(s, 1.6)).toBe(false);
    // Break-even: below 392.5pt of available width the caption must eject.
    expect(captionFitsInFace(instrumentScale(1.6, 392), 1.6)).toBe(false);
    expect(captionFitsInFace(instrumentScale(1.6, 393), 1.6)).toBe(true);
  });
});
