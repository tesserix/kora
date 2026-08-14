import { render, screen } from "@testing-library/react-native";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { instrumentDark, instrumentLight } from "@/theme/palette";

const SEX = [
  { key: "male", label: "Male" },
  { key: "female", label: "Female" },
];

type Rgb = readonly [number, number, number];

// Minimal colour maths, local to this test on purpose: the thing being
// asserted is the RATIO the user actually perceives, which cannot be spelled
// as "the token equals X" — a token swap that preserves the ratio is fine, one
// that quietly loses it is exactly the bug (kora#166).
function parseColor(input: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(input);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(input);
  if (!rgba) throw new Error(`unsupported colour: ${input}`);
  const parts = rgba[1].split(",").map((p) => Number(p.trim()));
  return { rgb: [parts[0], parts[1], parts[2]], alpha: parts.length > 3 ? parts[3] : 1 };
}

// Source-over compositing: the glass tokens are translucent, so their real
// on-screen colour only exists relative to whatever sits behind them.
function over(foreground: string, background: Rgb): Rgb {
  const { rgb, alpha } = parseColor(foreground);
  return [0, 1, 2].map((i) => rgb[i] * alpha + background[i] * (1 - alpha)) as unknown as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function flatten(style: unknown): Record<string, string> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, string>>((acc, s) => ({ ...acc, ...flatten(s) }), {});
  }
  return (style ?? {}) as Record<string, string>;
}

// The component renders in whichever scheme the test environment resolves;
// match the rendered track back to its palette so the page colour behind the
// glass is the real one rather than a guess.
// InstrumentTokens is literal-typed off the dark palette, so the two
// palettes have no common named type — the shape is what matters here.
type Palette = Record<string, string>;

function paletteFor(trackColor: string): Palette {
  if (trackColor === instrumentDark.glass) return instrumentDark;
  if (trackColor === instrumentLight.glass) return instrumentLight;
  throw new Error(`track colour ${trackColor} matches neither instrument palette`);
}

async function measure(value: string) {
  await render(<SegmentedGlass options={SEX} value={value} onChange={jest.fn()} />);
  const track = flatten(screen.getByTestId("segmented-glass").props.style);
  const palette = paletteFor(track.backgroundColor);
  const trackRgb = over(track.backgroundColor, parseColor(palette.bg).rgb);
  const tabs = screen.getAllByRole("tab").map((tab) => flatten(tab.props.style));
  return { trackRgb, tabs };
}

describe("SegmentedGlass selected state (kora#166)", () => {
  // WCAG 2.1 SC 1.4.11 non-text contrast: the indicator telling you which
  // option is active is a UI component boundary, so 3:1 against the adjacent
  // colour is the floor, not a nicety. The old `inset` well measured ~1.2:1
  // against the track in dark mode — a state change the eye cannot find.
  it("gives the selected segment at least 3:1 against the track", async () => {
    const { trackRgb, tabs } = await measure("male");
    const pill = over(tabs[0].backgroundColor, trackRgb);
    expect(contrastRatio(pill, trackRgb)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the selected label readable on top of the fill", async () => {
    const { trackRgb, tabs } = await measure("male");
    const pill = over(tabs[0].backgroundColor, trackRgb);
    const label = flatten(screen.getByText("Male").props.style);
    expect(contrastRatio(parseColor(label.color).rgb, pill)).toBeGreaterThanOrEqual(4.5);
  });

  it("fills only the selected segment", async () => {
    const { tabs } = await measure("male");
    expect(tabs[0].backgroundColor).not.toBe("transparent");
    expect(tabs[1].backgroundColor).toBe("transparent");
  });

  it("moves the fill with the value rather than lighting both", async () => {
    const { tabs } = await measure("female");
    expect(tabs[0].backgroundColor).toBe("transparent");
    expect(tabs[1].backgroundColor).not.toBe("transparent");
  });
});
