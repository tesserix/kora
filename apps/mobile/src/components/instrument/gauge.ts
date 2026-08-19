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
