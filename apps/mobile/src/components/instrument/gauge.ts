// Shared geometry for the GaugeDial hero instrument.
// spec: docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md
export const GAUGE_VIEW_W = 264;
export const GAUGE_VIEW_H = 178;
const CX = 132;
const CY = 146;
const R = 114;
const START = -205;
const END = 25;
const TICKS = 40;
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

const toXY = (deg: number, rad: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)];
};

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

export function needleFor(fraction: number) {
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
