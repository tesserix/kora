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
  | "numeral1" | "numeral2"
  | "largeTitle" | "title1" | "title2" | "title3"
  | "headline" | "body" | "callout" | "subheadline" | "footnote" | "caption" | "caption2";

// Sizes and leadings are Apple's Dynamic Type values verbatim. TRACKING is
// signed to agree with SF Pro rather than with the generic web rule (kora#177):
// AppText sets no fontFamily, so this all renders in SF, which already applies
// its own optical-size tracking — POSITIVE at display sizes (SF Display is
// drawn tight) and NEGATIVE at text sizes (SF Text is drawn loose). The old
// table inverted both, so a 34pt title landed 0.77pt tighter than the native
// chrome next to it. `undefined` means "let SF's own tracking stand".
//
// `maxScale` is Apple's own Dynamic Type CEILING for the variant, and it exists
// because RN's ramp is not Apple's (kora#274). RN multiplies EVERY authored
// size by one multiplier read from the content-size category — the BODY ramp,
// 0.941 at `medium` up to 3.571 at accessibility-XXXL. Apple's ramp is
// per-text-style and compresses hard at display sizes: largeTitle goes 34 ->
// 60pt across the same range, a ceiling of 1.765, because a headline is
// already large and does not need doubling to stay legible.
//
// Measured, not recalled — Apple's own Settings large title via
// `idb ui describe-all`, heights in pt on iPhone 17 Pro Max:
//
//   large 40.7 | xL 43.0 | xxxL 48.0 | AX1 52.7 | AX2 57.3
//   AX3 62.3 | AX4 67.0 | AX5 71.7
//
// Normalised to `large` that is 1.000 / 1.057 / 1.180 / 1.295 / 1.409 /
// 1.532 / 1.648 / 1.762 — Apple's published largeTitle table to within 0.4%.
// Against RN's 1.000 / 1.118 / 1.353 / 1.786 / 2.143 / 2.643 / 3.100 / 3.571,
// RN over-scales a large title by 1.73x at AX3 and 2.03x at AX5.
//
// That over-scale is the whole of kora#274: at AX3 a 34pt title renders at
// ~90pt, so "Notifications" needs ~520pt in a 360pt column and RN breaks it
// mid-word ("Notificat" / "ions") because there is no space to break at. The
// break is RN behaving correctly; the SIZE is what is wrong.
//
// This is NOT the cap kora#268 rejected. That one put a numeral BELOW what the
// platform would draw. This one is the platform's own ceiling: at every content
// size the capped title is still >= what iOS renders natively (60pt vs Apple's
// 52pt at AX3), and below AX1 it never engages at all, because RN's own
// multiplier does not reach 1.76 until the accessibility sizes. Nothing is
// traded away in the range where RN and Apple already agree.
//
// Only `largeTitle` carries one. title1/title2 have the same distortion in
// Apple's table (1.571 / 1.545 ceilings) but no reported breakage, and the text
// variants must NOT get one — Apple scales body 17 -> 53pt (3.118) against RN's
// 3.571, so RN is only 15% over there and capping body copy is a real
// accessibility loss for no layout gain.
//
// title3 / callout / caption2 / numeral1 / numeral2 are the steps kora#237
// added. The first three are the middle of Apple's own ramp that this table
// had skipped (title3 20/25, callout 16/21) or that the app had outgrown
// downwards (caption2, see its own note). They are named because call sites
// were reaching for raw literals at exactly these sizes — 16 appears 10 times,
// 9 twelve times — and a literal cannot be re-themed.
//
// Where an added step's Apple leading disagrees with Text.tsx's derived ratio,
// the APPLE value wins here, because the derived ratio exists to give an
// unnamed size a sane box, not to overrule a measured one:
//   callout  16 -> derived 21, Apple 21  (agree)
//   title3   20 -> derived 24, Apple 25  (+1, Apple's)
//   caption2  9 -> derived 13, authored 12 (-1)
// That disagreement is also why migrating a raw literal to one of these two is
// NOT free — see the note on the call-site sweep in kora#237.
export const type: Record<TypeVariant, { size: number; weight: "400" | "500" | "600" | "700"; letterSpacing?: number; lineHeight?: number; maxScale?: number }> = {
  // Display numerals sit ABOVE largeTitle and are not part of Apple's ramp —
  // no text style goes past 34pt, so a figure that has to read as an
  // instrument reading has nothing to name it. Both steps are taken from the
  // two sizes the app already draws, and both exist for the same reason: their
  // hand-authored leading is NOT what Text.tsx's derived ratio produces, and a
  // hand-tuned size/leading pair is exactly what a scale step is for.
  //   numeral1  meal.tsx's kcal hero, authored 64/72 (derived would be 74)
  //   numeral2  GaugeDial's centre numeral, authored 44/50 (derived would be 51)
  // Sizes with a leading the derived ratio already gets right are deliberately
  // NOT named — profile.tsx's 40 gets 46 from the ratio, which is the number it
  // authors by hand, so it needs no step (kora#237).
  //
  // Tracking is NEGATIVE here, against the SF rule documented above, and for a
  // reason that rule does not cover: these render in the monospaced data face,
  // not SF Pro, so there is no optical-size tracking to agree with — the
  // negative value is tightening a tabular face that sets loose at display
  // size. Both values are the ones the call sites already author.
  numeral1: { size: 64, weight: "700", letterSpacing: -2, lineHeight: 72 },
  numeral2: { size: 44, weight: "700", letterSpacing: -1.2, lineHeight: 50 },
  largeTitle: { size: 34, weight: "700", letterSpacing: 0.37, lineHeight: 41, maxScale: 1.76 },
  title1: { size: 28, weight: "700", letterSpacing: 0.36, lineHeight: 34 },
  title2: { size: 22, weight: "700", letterSpacing: 0.35, lineHeight: 28 },
  title3: { size: 20, weight: "700", letterSpacing: 0.38, lineHeight: 25 },
  headline: { size: 17, weight: "600", lineHeight: 22 },
  body: { size: 17, weight: "400", lineHeight: 22 },
  callout: { size: 16, weight: "400", lineHeight: 21 },
  subheadline: { size: 15, weight: "400", lineHeight: 20 },
  footnote: { size: 13, weight: "400", lineHeight: 18 },
  // SF's own caption1 tracking is +0.06. Kept wider for the small-caps-ish
  // editorial feel the captions carry, but a fifth of the old +0.5.
  caption: { size: 11, weight: "500", letterSpacing: 0.2, lineHeight: 13 },
  // NOT an Apple value — Apple's ramp stops at caption2 = 11/13, which is what
  // `caption` above already is. 9pt is below the platform floor and is named
  // here only because the app already draws at it in 12 places (tick labels,
  // engraved micro-captions) with no variant to reach for, which is half of
  // why kora#237 exists. Same +0.2 tracking as `caption` for the same
  // editorial reason; callers that engrave still set their own wider tracking.
  caption2: { size: 9, weight: "500", letterSpacing: 0.2, lineHeight: 12 },
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
  // Ignition finish (spec 2026-08-16): bezel bottom shading, recessed-well
  // inner line, and the two lume glows. Light mode is a different finish,
  // not a swap — see the light set.
  shade: "rgba(0,0,0,0.28)",
  wellShadow: "rgba(0,0,0,0.25)",
  lumeText: "rgba(237,230,212,0.30)",
  lumeAccent: "rgba(255,74,0,0.45)",
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
  // INK-tinted, not white (kora#167). White at 0.85 over a glass panel that is
  // itself near-white composited to 1.05:1 — a border with no border in it. The
  // same trap `inset` below already documents: on a light ground a boundary has
  // to be drawn *into* the surface, not lit on top of it. 0.28 reaches 1.84:1.
  //
  // Honest limit: a true 3:1 boundary here needs roughly a mid-grey (#8A8A8A),
  // which reads as a hard outline around every card and is a bigger aesthetic
  // change than a contrast fix should make unilaterally. Dark reaches 3.07:1
  // because it has the headroom; light does not without changing its character.
  glassBorder: "rgba(22,24,28,0.28)",
  // Stays white: this is the highlight catching the top edge, and it reads
  // against the ink border above rather than against the panel.
  glassHighlight: "rgba(255,255,255,0.95)",
  // Ink-tinted, NOT a white tint: a well is painted on `glass` (white at 60%
  // over a light ground), so a white inset came out lighter than its own
  // surround and every recess — segmented selection, the active tab well,
  // stepper pills, track backgrounds, glyph tiles — vanished. Dark's well is
  // darker than its panel; light's has to be too. 0.08 clears the near-white
  // panel by ~18 luminance levels: visible at a 7px segmented pill, still
  // reading as a recess in the material rather than a grey box on it.
  // Left at 0.08 on purpose. Deepening this to 0.12 (as the dark well was
  // deepened) drops `mut` on the well from ~4.62:1 to 4.25:1 and breaks the AA
  // guarantee the comment above it documents — instrument.test.ts pins exactly
  // that pair. Light's recess was already measured and tuned; unlike dark's, it
  // did not need re-deriving.
  inset: "rgba(22,24,28,0.08)",
  hairline: "rgba(22,24,28,0.14)",
  // 0.14 was 1.33:1 — gauge graduations that are not there. 0.50 reaches
  // 3.34:1, clearing SC 1.4.11 for meaningful non-text content.
  tick: "rgba(22,24,28,0.50)",
  tickLit: "#16181C",
  // Darkened from the shared #FF4A00 (kora#167). That value was 3.17:1 as text
  // on a light panel and — worse — 3.37:1 for `accentOn` white sitting on it,
  // which is the PRIMARY CTA LABEL failing AA. #D23800 is the lightest value
  // that clears 4.5 on both counts (4.58 text, 4.88 white-on), so it stays as
  // close to the brand orange as the requirement allows.
  //
  // The audit that found this proposed #D63900; measured, that is 4.44 text —
  // under the 4.5 line, so it would have shipped a still-failing CTA.
  //
  // Dark keeps #FF4A00 deliberately: on the dark panel it is already 5.43:1.
  // The accent differs by scheme because the requirement differs by scheme.
  accent: "#D23800",
  accentOn: "#FFFFFF",
  danger: "#D32F23",
  // 2.68:1 before — failing AA *and* the 3:1 non-text floor. #2C7871 is 4.89:1.
  // (The audit's #2F7F77 measures 4.46 — under the line, same trap as above.)
  teal: "#2C7871",
  shade: "rgba(22,24,28,0.12)",
  wellShadow: "rgba(22,24,28,0.08)",
  // OFF by design: a halo behind near-black numerals reads as smudge —
  // daylight dials don't glow.
  lumeText: "transparent",
  lumeAccent: "rgba(210,56,0,0.22)",
} as const satisfies Record<keyof typeof instrumentDark, string>;

export type InstrumentTokens = typeof instrumentDark;
export const INSTRUMENT_DARK_FIXED = instrumentDark;
