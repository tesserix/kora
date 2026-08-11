import Svg, { Circle, Line, Rect } from "react-native-svg";

// Kora's mark: the "dial K". An open 230° gauge arc of 41 ticks — lit up to
// the needle at 65%, dimmed past it — around a K whose upper arm is the
// signal-orange needle (counterweight tail through the hub). The geometry is
// identical to assets/brand/kora-*.svg, which are generated from the same
// constants; this component is the runtime rendering of that source of truth.
//
// Brand rules (assets/brand): the needle and hub are the only orange, the
// needle never rotates (65% depicts a healthy reserve, not a time of day),
// and the bottom gap stays open. Colors are brand-fixed, not themed — the
// mark does not recolor with the palette.
export const BRAND_LUME = "#EDE6D4";
export const BRAND_NEEDLE = "#FF4A00";

const VIEW = 240;
const CENTER = 120;
const RADIUS_OUTER = 112;
const START_DEG = -205;
const END_DEG = 25;
const TICKS = 40;
const MAJOR_EVERY = 5;
const LEN_MINOR = 9;
const LEN_MAJOR = 15;
const WIDTH_MINOR = 2.6;
const WIDTH_MAJOR = 4.2;
const NEEDLE_FRACTION = 0.65;

const STEM_X = 82;
const STEM_TOP = 66;
const STEM_BOTTOM = 174;
const STEM_WIDTH = 14;
const HUB = { x: STEM_X, y: 120 };
const ARM_UP = { x: 164, y: 58 };
const ARM_DOWN = { x: 164, y: 182 };
const TAIL = { x: 63, y: 136 };
const ARM_WIDTH = 13;
const HUB_RADIUS = 9;
const HUB_PIN_RADIUS = 3.6;

interface Tick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  opacity: number;
}

function buildTicks(): readonly Tick[] {
  const ticks: Tick[] = [];
  for (let i = 0; i <= TICKS; i++) {
    const t = i / TICKS;
    const angle = ((START_DEG + t * (END_DEG - START_DEG)) * Math.PI) / 180;
    const major = i % MAJOR_EVERY === 0;
    const length = major ? LEN_MAJOR : LEN_MINOR;
    const lit = t <= NEEDLE_FRACTION;
    ticks.push({
      x1: CENTER + (RADIUS_OUTER - length) * Math.cos(angle),
      y1: CENTER + (RADIUS_OUTER - length) * Math.sin(angle),
      x2: CENTER + RADIUS_OUTER * Math.cos(angle),
      y2: CENTER + RADIUS_OUTER * Math.sin(angle),
      width: major ? WIDTH_MAJOR : WIDTH_MINOR,
      opacity: lit ? (major ? 0.95 : 0.5) : major ? 0.28 : 0.14,
    });
  }
  return ticks;
}

const TICK_GEOMETRY = buildTicks();

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 40 }: BrandMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} testID="brand-mark">
      {TICK_GEOMETRY.map((tick, i) => (
        <Line
          key={i}
          testID={`brand-tick-${i}`}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
          stroke={BRAND_LUME}
          strokeOpacity={tick.opacity}
          strokeWidth={tick.width}
          strokeLinecap="round"
        />
      ))}
      <Rect
        testID="brand-stem"
        x={STEM_X - STEM_WIDTH / 2}
        y={STEM_TOP}
        width={STEM_WIDTH}
        height={STEM_BOTTOM - STEM_TOP}
        rx={STEM_WIDTH / 2}
        fill={BRAND_LUME}
      />
      <Line
        testID="brand-arm"
        x1={HUB.x}
        y1={HUB.y}
        x2={ARM_DOWN.x}
        y2={ARM_DOWN.y}
        stroke={BRAND_LUME}
        strokeWidth={ARM_WIDTH}
        strokeLinecap="round"
      />
      <Line
        testID="brand-needle"
        x1={TAIL.x}
        y1={TAIL.y}
        x2={ARM_UP.x}
        y2={ARM_UP.y}
        stroke={BRAND_NEEDLE}
        strokeWidth={ARM_WIDTH}
        strokeLinecap="round"
      />
      <Circle testID="brand-hub" cx={HUB.x} cy={HUB.y} r={HUB_RADIUS} fill={BRAND_NEEDLE} />
      <Circle cx={HUB.x} cy={HUB.y} r={HUB_PIN_RADIUS} fill={BRAND_LUME} />
    </Svg>
  );
}
