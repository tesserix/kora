import { PixelRatio, StyleSheet } from "react-native";
import { render } from "@testing-library/react-native";
import { AppText } from "../Text";
import { Numeral } from "../Numeral";
import { type as typeScale } from "@/theme/palette";

// AppText merges caller `style` AFTER its own variant style, so a caller that
// overrides `fontSize` but not `lineHeight` used to inherit `body`'s fixed
// 22pt line box (kora#177). These pin the derived-leading rule: leading comes
// from the EFFECTIVE size, and the ratio steps DOWN as the size grows.
function leading(style: unknown): { fontSize: number; lineHeight: number } {
  const flat = StyleSheet.flatten(style as never) as { fontSize: number; lineHeight: number };
  return { fontSize: flat.fontSize, lineHeight: flat.lineHeight };
}

// RN's jest preset resolves PixelRatio.getFontScale() to the mocked pixel ratio
// (2), not to 1, so the default Dynamic Type scale has to be pinned explicitly
// or every expectation below reads doubled.
beforeEach(() => jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(1));
afterEach(() => jest.restoreAllMocks());

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

// RN scales `fontSize` for Dynamic Type but never `lineHeight`, so a fixed pt
// line box collapses to zero spacing at accessibility text sizes and multi-line
// copy runs together (kora#177). The derived box has to track the size the OS
// actually renders, not the one written in the style.
describe("leading scales with Dynamic Type", () => {
  it("grows the derived line box by the user's font scale", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const { getByText } = await render(<AppText style={{ fontSize: 15 }}>hi</AppText>);
    expect(leading(getByText("hi").props.style).lineHeight).toBe(39); // 15 * 1.3 * 2
  });

  it("grows a variant's own line box too", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const { getByText } = await render(<AppText variant="body">hi</AppText>);
    expect(leading(getByText("hi").props.style).lineHeight).toBe(44); // 22 * 2
  });

  it("does not scale the box when the caller turns glyph scaling off", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const { getByText } = await render(
      <AppText allowFontScaling={false} style={{ fontSize: 15 }}>
        hi
      </AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(20);
  });

  it("caps the box at the caller's maxFontSizeMultiplier", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(3);
    const { getByText } = await render(
      <AppText maxFontSizeMultiplier={1.5} style={{ fontSize: 15 }}>
        hi
      </AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(29); // 15 * 1.3 * 1.5
  });

  it("leaves an explicit caller lineHeight alone", async () => {
    jest.spyOn(PixelRatio, "getFontScale").mockReturnValue(2);
    const { getByText } = await render(
      <AppText style={{ fontSize: 64, lineHeight: 72 }}>hi</AppText>,
    );
    expect(leading(getByText("hi").props.style).lineHeight).toBe(72);
  });
});
