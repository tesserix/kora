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
