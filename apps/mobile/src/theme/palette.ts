// Hand-authored iOS-native palette. Light/dark pairs.
const shared = {
  primaryForeground: "#FFFFFF",
  destructiveForeground: "#FFFFFF",
} as const;

export const lightColors = {
  ...shared,
  background: "#F2F2F7",
  foreground: "#000000",
  label: "#000000",
  secondaryLabel: "rgba(60,60,67,0.60)",
  tertiaryLabel: "rgba(60,60,67,0.30)",
  card: "#FFFFFF",
  cardForeground: "#000000",
  cardSecondary: "#F2F2F7",
  primary: "#34C759",
  secondary: "#F2F2F7",
  secondaryForeground: "#000000",
  muted: "#F2F2F7",
  mutedForeground: "rgba(60,60,67,0.60)",
  accent: "#34C759",
  accentForeground: "#FFFFFF",
  accentAmber: "#FF9500",
  accentBlue: "#007AFF",
  destructive: "#FF3B30",
  border: "rgba(60,60,67,0.29)",
  separator: "rgba(60,60,67,0.29)",
  input: "#F2F2F7",
  ring: "#34C759",
  success: "#34C759",
  warning: "#FF9500",
  error: "#FF3B30",
  info: "#007AFF",
  elevated: "#FFFFFF",
} as const;

export const darkColors: Record<keyof typeof lightColors, string> = {
  ...shared,
  background: "#0A0D0B",
  foreground: "#FFFFFF",
  label: "#F3F7F2",
  secondaryLabel: "rgba(233,242,232,0.62)",
  tertiaryLabel: "rgba(233,242,232,0.34)",
  card: "#151A16",
  cardForeground: "#FFFFFF",
  cardSecondary: "#1C231D",
  primary: "#3DDC6E",
  primaryForeground: "#06120A",
  secondary: "#1C231D",
  secondaryForeground: "#FFFFFF",
  muted: "rgba(255,255,255,0.07)",
  mutedForeground: "rgba(233,242,232,0.62)",
  accent: "#3DDC6E",
  accentForeground: "#06120A",
  accentAmber: "#FFB23E",
  accentBlue: "#4FA8FF",
  destructive: "#FF453A",
  border: "rgba(255,255,255,0.09)",
  separator: "rgba(255,255,255,0.08)",
  input: "#1C231D",
  ring: "#3DDC6E",
  success: "#3DDC6E",
  warning: "#FF9F0A",
  error: "#FF453A",
  info: "#0A84FF",
  elevated: "#1C231D",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, "2xl": 48, "3xl": 64 } as const;
export const radius = { sm: 6, md: 10, lg: 12, xl: 16, "2xl": 24, "3xl": 32, full: 9999 } as const;
export const fontSize = { xs: 11, sm: 13, base: 15, lg: 17, xl: 22, "2xl": 28, "3xl": 34, "4xl": 40, "5xl": 52 } as const;

export type TypeVariant =
  | "largeTitle" | "title1" | "title2" | "headline" | "body" | "subheadline" | "footnote" | "caption";

export const type: Record<TypeVariant, { size: number; weight: "400" | "500" | "600" | "700"; letterSpacing: number; lineHeight?: number }> = {
  largeTitle: { size: 34, weight: "700", letterSpacing: -0.4, lineHeight: 41 },
  title1: { size: 28, weight: "700", letterSpacing: -0.4, lineHeight: 34 },
  title2: { size: 22, weight: "700", letterSpacing: -0.3, lineHeight: 28 },
  headline: { size: 17, weight: "600", letterSpacing: 0, lineHeight: 22 },
  body: { size: 17, weight: "400", letterSpacing: 0, lineHeight: 22 },
  subheadline: { size: 15, weight: "400", letterSpacing: 0, lineHeight: 20 },
  footnote: { size: 13, weight: "400", letterSpacing: 0, lineHeight: 18 },
  caption: { size: 11, weight: "500", letterSpacing: 0.5, lineHeight: 13 },
};

export type GradientSet = {
  green: [string, string];
  amber: [string, string];
  blue: [string, string];
};

// 2-stop [bright, deep] gradient pairs per scheme, tuned so the arc reads as a
// filled sweep. Still used by out-of-scope legacy screens (profile.tsx,
// Card.tsx) that keep the old green/amber/blue palette; the former
// steps/sleep/fibre keys were dropped as dead code (M10) once every in-scope
// surface migrated to instrument tokens — `sleep` was also a banned violet
// hue the Instrument Glass spec prohibits.
export const gradientStops: { light: GradientSet; dark: GradientSet } = {
  light: {
    green: ["#34C759", "#1E9E4A"],
    amber: ["#FFB340", "#F08C00"],
    blue: ["#4DA2FF", "#0A63D6"],
  },
  dark: {
    green: ["#3DDC6E", "#12A150"],
    amber: ["#FFC15E", "#FF9F0A"],
    blue: ["#6FB6FF", "#0A84FF"],
  },
};

// Instrument Glass tokens (spec: docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md).
// Lives beside the legacy palette during migration; new code uses these.
export const instrumentDark = {
  bg: "#0B0D10",
  ink: "#EDE6D4",
  mut: "#89929D",
  // Raised from rgba(24,28,35,0.55) (kora#167). Composited over `bg` the old
  // value was #12151A — 1.06:1, three luminance levels, a panel body that
  // contributed nothing and left `shadows.card` doing 100% of the separation
  // against a near-black ground it had nowhere to fall on. This composites to
  // ~#222831, ~1.31:1: roughly 5x the luminance delta, still glass.
  glass: "rgba(34,40,49,0.62)",
  // 0.10 composited to 1.27:1 against the panel — an edge you cannot see.
  // 0.38 reaches ~3.07:1, clearing WCAG 1.4.11's 3:1 floor for a boundary that
  // is doing real work. (Measured curve: 0.10=1.27, 0.20=1.73, 0.30=2.40.)
  glassBorder: "rgba(237,230,212,0.38)",
  // The "light catching the material" top edge. Raised in proportion to the
  // border so it still reads as a highlight rather than becoming a second rule.
  glassHighlight: "rgba(237,230,212,0.16)",
  // Deepened, NOT inverted (kora#167). The audit that found this proposed
  // flipping the dark well to an ink tint, on the grounds that a near-black
  // panel has no headroom left to darken into. That was true of the OLD panel
  // and stopped being true one line above: lifting `glass` moved the panel from
  // luminance 21.0 to 29.3, which hands the recess its headroom back. Inverting
  // it would have made every well read as raised rather than sunk — the recess
  // invariant in src/theme/__tests__/instrument.test.ts caught exactly that.
  //
  // Same alpha family as before, one step deeper: the step against the panel
  // goes from 4.08 (its own test demands >= 4, so it was passing by 0.08) to
  // ~9.1. The well is still the darkest thing in the material, and now visibly.
  inset: "rgba(11,13,16,0.55)",
  hairline: "rgba(237,230,212,0.16)",
  // 0.15 was 1.47:1. A gauge graduation is meaningful non-text content and owes
  // 3:1; at the old value the dials read as a lit pointer floating on nothing,
  // which is half of what kora#167 describes as "flat".
  tick: "rgba(237,230,212,0.42)",
  tickLit: "#EDE6D4",
  accent: "#FF4A00",
  accentOn: "#0B0D10",
  // #E23B2E was 4.27:1 on a dark panel — just under AA for the 15px destructive
  // row titles it is used for.
  danger: "#EC4E40",
  teal: "#48A89E",
} as const;

export const instrumentLight = {
  bg: "#ECEDEF",
  ink: "#16181C",
  // Darkened from #6D7580 so 9-11px engraved labels clear WCAG AA (4.5:1)
  // against the light inset well, which is the worst case at ~4.62:1 — the
  // old value sat at 3.40:1 there and ~4.38:1 on a glass panel. Dark mode's
  // `mut` is unchanged; it already passes at ~6.2:1.
  mut: "#5A6069",
  glass: "rgba(255,255,255,0.60)",
  glassBorder: "rgba(255,255,255,0.85)",
  glassHighlight: "rgba(255,255,255,0.95)",
  // Ink-tinted, NOT a white tint: a well is painted on `glass` (white at 60%
  // over a light ground), so a white inset came out lighter than its own
  // surround and every recess — segmented selection, the active tab well,
  // stepper pills, track backgrounds, glyph tiles — vanished. Dark's well is
  // darker than its panel; light's has to be too. 0.08 clears the near-white
  // panel by ~18 luminance levels: visible at a 7px segmented pill, still
  // reading as a recess in the material rather than a grey box on it.
  inset: "rgba(22,24,28,0.08)",
  hairline: "rgba(22,24,28,0.09)",
  tick: "rgba(22,24,28,0.14)",
  tickLit: "#16181C",
  accent: "#FF4A00",
  accentOn: "#FFFFFF",
  danger: "#D32F23",
  teal: "#48A89E",
} as const satisfies Record<keyof typeof instrumentDark, string>;

export type InstrumentTokens = typeof instrumentDark;
export const INSTRUMENT_DARK_FIXED = instrumentDark;
