// Shared geometry for the GaugeDial hero instrument.
// spec: docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md
export const GAUGE_VIEW_W = 264;
export const GAUGE_VIEW_H = 178;
// Hub/needle-pivot coordinates, exported so consumers (e.g. GaugeDial's center
// overlay) can derive layout from the same geometry instead of hardcoding it.
export const GAUGE_CENTER_X = 132;
export const GAUGE_CENTER_Y = 146;
const CX = GAUGE_CENTER_X;
const CY = GAUGE_CENTER_Y;
const R = 114;
const START = -205;
const END = 25;
// Exported so consumers deriving a per-tick fraction (GaugeDial's and PlanDial's
// animated ticks both compute `index / TICKS` to find their lit threshold) share
// this number instead of hardcoding it alongside the array it produces.
export const GAUGE_TICKS = 40;
const TICKS = GAUGE_TICKS;
const MAJOR_EVERY = 5;

export interface GaugeTick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  major: boolean;
  lit: boolean;
  red: boolean;
}

// "worklet" directive required: needleFor (below) runs on the UI thread inside
// GaugeDial's useAnimatedProps. Reanimated's babel plugin only auto-workletizes
// the function literal passed directly to a hook (useAnimatedProps/useAnimatedStyle/
// etc.) — any NAMED function that worklet then calls, in this file or any other,
// is a captured closure value and crosses to the UI runtime as a remote function
// reference unless it carries its own directive (confirmed on-device: this class
// hit both toXY/needleFor here and tickColorFor in GaugeDial.tsx, despite the
// latter being in the SAME file as its call site — "same file" does not save
// you). Same underlying crash class as AnimatedNumber's remote-call crash
// (e557c50): "[Worklets] Tried to synchronously call a Remote Function". Do not
// remove.
const toXY = (deg: number, rad: number): [number, number] => {
  "worklet";
  const a = (deg * Math.PI) / 180;
  return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
};

// Only `.lit` depends on `fraction`; every other field (position, width, major,
// red) is a function of the module constants above. Consumers that animate the
// lit boundary on the UI thread (GaugeDial, and since kora#238 PlanDial) build
// this ONCE with an arbitrary argument and ignore `.lit` — see
// PlanDial.rebuild.test.tsx, which pins that invariant.
export function buildGaugeTicks(fraction: number): GaugeTick[] {
  const out: GaugeTick[] = [];
  for (let i = 0; i <= TICKS; i++) {
    const t = i / TICKS;
    const deg = START + t * (END - START);
    const major = i % MAJOR_EVERY === 0;
    const [x1, y1] = toXY(deg, major ? R - 14 : R - 8);
    const [x2, y2] = toXY(deg, R);
    out.push({ x1, y1, x2, y2, width: major ? 2.5 : 1.25, major, lit: t <= fraction, red: t > 0.9 });
  }
  return out;
}

// "worklet" directive required: called from GaugeDial's useAnimatedProps on the
// UI thread — a named function referenced from inside a worklet, not the
// worklet literal itself, so it must carry its own directive (see toXY's
// comment above for the full explanation). Without it this crashes on-device
// the same way AnimatedNumber's did (e557c50), even though it passes fine
// under the jest reanimated mock, which evaluates worklet factories as plain
// synchronous JS regardless of worklet-ness. Do not remove.
export function needleFor(fraction: number) {
  "worklet";
  const deg = START + Math.min(Math.max(fraction, 0), 1) * (END - START);
  const [x1, y1] = toXY(deg, 26);
  const [x2, y2] = toXY(deg, R - 20);
  return { x1, y1, x2, y2 };
}

export function scaleAnchor(t: number): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  const deg = START + t * (END - START);
  const [x, y] = toXY(deg, R - 26);
  return { x, y: y + 3, anchor: t < 0.25 ? "start" : t > 0.75 ? "end" : "middle" };
}

// --- Dynamic Type for the instrument itself (kora#268, kora#284) -------------
//
// An <Svg> with a fixed viewBox draws at the same physical size at xSmall and
// at AX5, so everything above is outside Dynamic Type entirely — the same root
// cause as the unscaled tick labels kora#261 fixed, one level up. The fix is
// the same shape as TickRuler's: drive the RENDERED width/height off
// `useWindowDimensions().fontScale`, leave the viewBox alone. No tick, needle
// worklet or anchor below/above changes; it is a pure vector scale.

/**
 * Ceiling on the face scale.
 *
 * 1.6 because that is already the centre numeral's `maxFontSizeMultiplier` in
 * GaugeDial: the face and its largest occupant then share one ceiling, so the
 * numeral cannot outgrow the dial it sits in no matter how far the system
 * scale is pushed.
 *
 * In practice this is the VERTICAL/legibility ceiling, not the operative
 * constraint — the width clamp in `instrumentScale` binds first on every
 * supported device (GAUGE_VIEW_W * 1.6 = 422.4pt against a 393pt narrowest
 * screen), so no device reaches 1.6 at full width.
 */
export const INSTRUMENT_SCALE_MAX = 1.6;

const clampScale = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);

/**
 * The multiplier the instrument's rendered size actually uses: the system font
 * scale, floored at 1 and capped both by `max` and by what `maxWidth` can hold.
 *
 * Floored at 1 in BOTH directions for the same reason TickRuler's
 * `labelFontScale` is — a user who SHRANK their text must never get a dial
 * smaller than the design. It also keeps `medium` byte-identical, which is what
 * lets the existing goldens at the default content size stand.
 *
 * A `maxWidth` that is not a finite number > 0 returns the unclamped want
 * rather than clamping to zero. This is the single most important guard here:
 * it is the kora#270 failure mode, where a dimension resolves to 0 on an early
 * frame and the collapsed result reads as deliberate whitespace for the
 * component's entire life rather than as a missing measurement. Better to draw
 * one frame slightly too wide than to draw nothing forever.
 */
export function instrumentScale(
  fontScale: number,
  maxWidth: number,
  max: number = INSTRUMENT_SCALE_MAX,
): number {
  const want = clampScale(fontScale, 1, max);
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return want;
  return Math.min(want, Math.max(1, maxWidth / GAUGE_VIEW_W));
}

// --- Centre-overlay fit (kora#268) -------------------------------------------
//
// These numbers are GaugeDial's, and they currently live implicitly in its JSX.
// They are lifted here so the fit arithmetic is testable and so a change to the
// overlay's inset or the numeral's line height fails a test instead of quietly
// re-opening kora#268's collision.

/** GaugeDial's centre overlay `top: "38%"`, as a fraction. */
export const OVERLAY_TOP_RATIO = 0.38;
/** Radius of the <Circle> hub dot at (GAUGE_CENTER_X, GAUGE_CENTER_Y). */
export const HUB_DOT_R = 4.5;
/** The centre numeral's line height and its `maxFontSizeMultiplier`. */
export const NUMERAL_LINE_HEIGHT = 50;
export const NUMERAL_MAX_SCALE = 1.6;
/** The caption below the numeral: its size, its cap, and its `marginTop`. */
export const CAPTION_FONT_SIZE = 10;
export const CAPTION_MAX_SCALE = 1.4;
export const CAPTION_GAP = 6;
/**
 * RN's default leading as a multiple of font size, for the caption — which
 * sets no explicit `lineHeight`, so this is an ESTIMATE, not a metric. An
 * estimate is the right tool: SVG-adjacent text gives no metrics here, and
 * being a point generous costs a point of ejection threshold and nothing else.
 */
export const CAPTION_LINE_RATIO = 1.7;

/**
 * Vertical room the centre overlay has for its content, in points, at face
 * scale `s`: from the overlay's top inset down to the top of the hub dot.
 *
 * At s = 1 this is 73.86pt — kora#268's own device measurement (overlay top
 * 67.6pt, hub-dot top 141.5pt), re-derived from the constants rather than
 * copied, and pinned by a test so the two cannot drift apart silently.
 */
export function overlayBudget(scale: number): number {
  return scale * (GAUGE_CENTER_Y - HUB_DOT_R - OVERLAY_TOP_RATIO * GAUGE_VIEW_H);
}

/**
 * Height the overlay's content wants at a given system font scale: numeral
 * line box + gap + caption line box, each capped by its own
 * `maxFontSizeMultiplier` and floored at 1 to match `instrumentScale`.
 *
 * 73pt at fontScale 1 against a 73.86pt budget — the ~1pt of slack kora#268
 * reports at design size.
 */
export function overlayStack(fontScale: number): number {
  const numeral = NUMERAL_LINE_HEIGHT * clampScale(fontScale, 1, NUMERAL_MAX_SCALE);
  const caption =
    CAPTION_FONT_SIZE * CAPTION_LINE_RATIO * clampScale(fontScale, 1, CAPTION_MAX_SCALE);
  return numeral + CAPTION_GAP + caption;
}

/**
 * Whether the caption still belongs INSIDE the face at this combination of
 * face scale and font scale. When false, GaugeDial ejects it below the dial,
 * where its room is unbounded (kora#268's own aside, adopted as a derived
 * condition rather than a breakpoint). The numeral never ejects — it is the
 * instrument's readout.
 */
export function captionFitsInFace(scale: number, fontScale: number): boolean {
  return overlayBudget(scale) >= overlayStack(fontScale);
}
