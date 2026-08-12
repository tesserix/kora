import { instrumentDark, instrumentLight } from "../palette";

const KEYS = [
  "bg", "ink", "mut", "glass", "glassBorder", "glassHighlight",
  "inset", "hairline", "tick", "tickLit", "accent", "accentOn", "danger", "teal",
] as const;

test("both instrument themes define every token", () => {
  for (const k of KEYS) {
    expect(typeof instrumentDark[k]).toBe("string");
    expect(typeof instrumentLight[k]).toBe("string");
  }
});

test("the accent is signal orange in both themes and nothing is purple", () => {
  expect(instrumentDark.accent).toBe("#FF4A00");
  expect(instrumentLight.accent).toBe("#FF4A00");
  // the legacy purple sleepMetric must not leak into instrument tokens
  const all = [...Object.values(instrumentDark), ...Object.values(instrumentLight)];
  expect(all.some((v) => /7A6BFF|8B7CFF/i.test(v))).toBe(false);
});

test("grounds and ink swap between themes", () => {
  expect(instrumentDark.bg).toBe("#0B0D10");
  expect(instrumentLight.bg).toBe("#ECEDEF");
  expect(instrumentDark.ink).toBe("#EDE6D4");
  expect(instrumentLight.ink).toBe("#16181C");
});

// --- recess invariant -------------------------------------------------------
// A `inset` well is painted ON TOP of a `glass` panel, which is itself painted
// on top of `bg`. What the eye compares is therefore the composited well
// against the composited panel — not the two token strings. If the well ends
// up LIGHTER than the panel it surrounds, the recess reads as a raised bump
// (or, on a near-white light panel, as nothing at all). Model the real stack
// and assert the direction of the step in both themes.

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgb {
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
  }
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!hex) throw new Error(`unsupported color: ${value}`);
  return { r: parseInt(hex[1], 16), g: parseInt(hex[2], 16), b: parseInt(hex[3], 16), a: 1 };
}

/** Source-over composite of `top` onto an already-opaque `base`. */
function over(top: string, base: Rgb): Rgb {
  const t = parseColor(top);
  return {
    r: t.r * t.a + base.r * (1 - t.a),
    g: t.g * t.a + base.g * (1 - t.a),
    b: t.b * t.a + base.b * (1 - t.a),
    a: 1,
  };
}

/** Rec. 709 relative luminance, 0–255. */
function luminance(c: Rgb): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

describe.each([
  ["dark", instrumentDark],
  ["light", instrumentLight],
])("%s theme recess invariant", (_name, t) => {
  const ground = parseColor(t.bg);
  const panel = over(t.glass, ground);
  const well = over(t.inset, panel);

  test("an inset well is darker than the glass panel it sits in", () => {
    expect(luminance(well)).toBeLessThan(luminance(panel));
  });

  test("the recess step is a real step, not a rounding artefact", () => {
    expect(luminance(panel) - luminance(well)).toBeGreaterThanOrEqual(4);
  });
});

// The light panel is near-white (glass is white at 60% over a light ground),
// so the well has to be ink-tinted AND deep enough to survive that ceiling —
// this is the regression the METRIC/LIGHT segments hit when `inset` was a
// white tint. Capped so the well stays a recess in the material and not an
// opaque grey box painted on it.
test("the light well clears the near-white panel by a visible margin", () => {
  const panel = over(instrumentLight.glass, parseColor(instrumentLight.bg));
  const well = over(instrumentLight.inset, panel);
  const step = luminance(panel) - luminance(well);
  expect(step).toBeGreaterThanOrEqual(12);
  expect(step).toBeLessThanOrEqual(30);
});

test("the light inset is ink-tinted, mirroring dark's ground-tinted well", () => {
  const inset = parseColor(instrumentLight.inset);
  const ink = parseColor(instrumentLight.ink);
  expect([inset.r, inset.g, inset.b]).toEqual([ink.r, ink.g, ink.b]);
});

// --- WCAG AA contrast for engraved labels -----------------------------------
// `mut` carries every engraved label (Field's caption, secondary text, unlit
// dial captions) across ~40 components. At 9-11px there is no WCAG large-text
// exception, so the floor is 4.5:1. The worst-case surface is Field's input
// well: `inset` composited directly on `bg` (Field sits straight on the
// screen ground, not inside a glass panel — see AuthScaffold/sign-in.tsx).
// This asserts the real contrast ratio, not a hex literal, so the guarantee
// survives a future palette tweak instead of silently drifting with it.

/** WCAG relative luminance (gamma-corrected), formula per WCAG 2.x 1.4.3. */
function relativeLuminance(c: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio between two colors, per WCAG 2.x 1.4.3 (range 1-21). */
function contrastRatio(a: Rgb, b: Rgb): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

test("light-mode mut clears WCAG AA (4.5:1) against Field's inset well", () => {
  const insetOnBg = over(instrumentLight.inset, parseColor(instrumentLight.bg));
  const ratio = contrastRatio(parseColor(instrumentLight.mut), insetOnBg);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});
