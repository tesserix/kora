# Kora Instrument Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Kora's five core screens (Home, Diary, Capture, Trends, Meal detail) in the approved Instrument Glass design language — chronograph gauges + translucent glass panels — with full light/dark theming.

**Architecture:** Presentation-layer rebuild only: every screen keeps its existing data hooks, routes, and business logic. A new `instrument` token namespace is added beside the legacy palette (which stays until the last screen migrates). New signature components (`GaugeDial`, `SubDial`, `GlassPanel`, etc.) live in `src/components/instrument/` and share geometry constants with `BrandMark.tsx`.

**Tech Stack:** React Native (Expo SDK 57), `react-native-svg` 15.x, `expo-blur`, `react-native-reanimated` 4.x, `expo-haptics`, Jest + `@testing-library/react-native`.

**Spec:** `docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md` — read it first; its token table and accent rules are normative.

## Global Constraints

- Working branch: `feat/brand-dial-k` (brand mark + spec already on it).
- Accent `#FF4A00` appears only as: needle+hub, redline/over-budget, primary CTA, active-tab dot, streak-hit cells, "to go" emphasis. Never two competing accent elements in one view.
- No purple anywhere (the legacy `sleepMetric` purple is retired by Task 1).
- Every mutable numeral uses the mono font + `fontVariant: ["tabular-nums"]`.
- Engraved labels (uppercase, letterSpacing ≥ 1.4): max ~4 visible per screen; everything else sentence case.
- Glass never stacks on glass; one elevation level.
- Capture screen is always dark, regardless of theme.
- All existing tests must stay green after every task. Run scoped tests per task; run the full suite (`npx jest`) plus `npx tsc --noEmit` before each commit.
- Commits: single-line conventional messages, no signatures, no multi-line bodies.
- All paths below are relative to `apps/mobile/`.

---

### Task 1: Instrument token namespace in the theme

**Files:**
- Modify: `src/theme/palette.ts`
- Modify: `src/theme/index.ts`
- Test: `src/theme/__tests__/instrument.test.ts` (create)

**Interfaces:**
- Produces: `instrumentDark` / `instrumentLight` exported from `palette.ts`, and `useTheme()` returning an added `instrument` key typed `InstrumentTokens`. Token keys (all `string`): `bg, ink, mut, glass, glassBorder, glassHighlight, inset, hairline, tick, tickLit, accent, accentOn, danger, teal`. Also `INSTRUMENT_DARK_FIXED` — alias of `instrumentDark` for the capture screen's theme opt-out.

- [ ] **Step 1: Write the failing test**

```ts
// src/theme/__tests__/instrument.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/theme/__tests__/instrument.test.ts`
Expected: FAIL — `instrumentDark` is not exported.

- [ ] **Step 3: Add the tokens to `palette.ts`**

Append after the existing exports (copy values verbatim from the spec's token table):

```ts
// Instrument Glass tokens (spec: docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md).
// Lives beside the legacy palette during migration; new code uses these.
export const instrumentDark = {
  bg: "#0B0D10",
  ink: "#EDE6D4",
  mut: "#89929D",
  glass: "rgba(24,28,35,0.55)",
  glassBorder: "rgba(237,230,212,0.10)",
  glassHighlight: "rgba(237,230,212,0.07)",
  inset: "rgba(11,13,16,0.50)",
  hairline: "rgba(237,230,212,0.08)",
  tick: "rgba(237,230,212,0.15)",
  tickLit: "#EDE6D4",
  accent: "#FF4A00",
  accentOn: "#0B0D10",
  danger: "#E23B2E",
  teal: "#48A89E",
} as const;

export const instrumentLight: Record<keyof typeof instrumentDark, string> = {
  bg: "#ECEDEF",
  ink: "#16181C",
  mut: "#6D7580",
  glass: "rgba(255,255,255,0.60)",
  glassBorder: "rgba(255,255,255,0.85)",
  glassHighlight: "rgba(255,255,255,0.95)",
  inset: "rgba(255,255,255,0.40)",
  hairline: "rgba(22,24,28,0.09)",
  tick: "rgba(22,24,28,0.14)",
  tickLit: "#16181C",
  accent: "#FF4A00",
  accentOn: "#FFFFFF",
  danger: "#D32F23",
  teal: "#48A89E",
} as const;

export type InstrumentTokens = typeof instrumentDark;
export const INSTRUMENT_DARK_FIXED = instrumentDark;
```

- [ ] **Step 4: Expose `instrument` from `useTheme` in `src/theme/index.ts`**

```ts
import {
  darkColors, fontSize, gradientStops, lightColors, radius, spacing, type,
  instrumentDark, instrumentLight, type InstrumentTokens,
} from "./palette";
// inside useTheme():
const instrument: InstrumentTokens = scheme === "dark" ? instrumentDark : instrumentLight;
return { colors, spacing, radius, fontSize, fonts, shadows: makeShadows(scheme), scheme, type, gradients, instrument } as const;
```

Re-export `INSTRUMENT_DARK_FIXED` and `InstrumentTokens` from `index.ts` so screens import everything from `@/theme`.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx jest src/theme && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/theme
git commit -m "feat(mobile): add instrument-glass token namespace to the theme"
```

---

### Task 2: `GlassPanel` — the material

**Files:**
- Create: `src/components/instrument/GlassPanel.tsx`
- Test: `src/components/instrument/__tests__/GlassPanel.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument` (Task 1).
- Produces: `GlassPanel({ children, style?, radius? = 24, testID? })` — a View wrapping `expo-blur`'s `BlurView` with the glass fill, 1px border, top highlight and card shadow. When Reduce Transparency is on (via `useReducedTransparency()` hook, also produced here and exported), renders an opaque fallback (`#14171C` dark / `#F7F7F8` light) with no BlurView.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/instrument/__tests__/GlassPanel.test.tsx
import { Text } from "react-native";
import { render } from "@testing-library/react-native";
import { GlassPanel } from "../GlassPanel";

// expo-blur's BlurView renders a host component we can find by testID.
test("renders children inside the blur material", async () => {
  const { getByText, getByTestId } = await render(
    <GlassPanel testID="panel"><Text>770</Text></GlassPanel>,
  );
  expect(getByText("770")).toBeTruthy();
  expect(getByTestId("panel-blur")).toBeTruthy();
});

test("respects a custom radius on the outer shell", async () => {
  const { getByTestId } = await render(
    <GlassPanel testID="panel" radius={18}><Text>x</Text></GlassPanel>,
  );
  const style = getByTestId("panel").props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style;
  expect(flat.borderRadius).toBe(18);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/components/instrument/__tests__/GlassPanel.test.tsx`
Expected: FAIL — module not found. If `expo-blur` needs a Jest mock, add to the test file:
`jest.mock("expo-blur", () => ({ BlurView: require("react-native").View }));` — but first check `jest.config`/existing mocks; other Expo modules already work in this suite.

- [ ] **Step 3: Implement**

```tsx
// src/components/instrument/GlassPanel.tsx
import { useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "@/theme";

// One elevation level; glass never stacks on glass (spec: Shape and material).
export function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceTransparencyEnabled?.().then((v) => live && setReduced(!!v));
    const sub = AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", (v) => setReduced(!!v));
    return () => { live = false; sub?.remove?.(); };
  }, []);
  return reduced;
}

export interface GlassPanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  testID?: string;
}

export function GlassPanel({ children, style, radius = 24, testID }: GlassPanelProps) {
  const { instrument, scheme, shadows } = useTheme();
  const reduced = useReducedTransparency();
  const shell: ViewStyle = {
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: instrument.glassBorder,
    overflow: "hidden",
    backgroundColor: reduced ? (scheme === "dark" ? "#14171C" : "#F7F7F8") : "transparent",
  };
  return (
    <View testID={testID} style={[shell, shadows.card, style]}>
      {!reduced && (
        <BlurView
          testID={testID ? `${testID}-blur` : undefined}
          intensity={scheme === "dark" ? 25 : 40}
          tint={scheme === "dark" ? "dark" : "light"}
          style={[StyleSheet.absoluteFill, { backgroundColor: instrument.glass }]}
        />
      )}
      {/* top highlight — light catching the material */}
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.glassHighlight }} />
      {children}
    </View>
  );
}
```

If the blur testID doesn't reach the host in tests, keep the mock from Step 2 and assert on the mocked View's testID.

- [ ] **Step 4: Run tests, typecheck**

Run: `npx jest src/components/instrument && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/instrument
git commit -m "feat(mobile): add GlassPanel material with reduce-transparency fallback"
```

---

### Task 3: Ambient pools in `AppBackground`

**Files:**
- Modify: `src/components/AppBackground.tsx` (read it fully first; keep its public usage — it renders behind screens with no props)
- Test: `src/components/__tests__/AppBackground.test.tsx` (create or extend if present)

**Interfaces:**
- Consumes: `useTheme().instrument`, `react-native-svg` (`Svg`, `Defs`, `RadialGradient`, `Stop`, `Rect`).
- Produces: `AppBackground` fills its parent with `instrument.bg` and three static radial pools per the spec — dark: orange 0.09 upper-left, teal 0.08 mid-right, warm `#FF9450` 0.06 bottom; light: same hues at 0.14/0.13/0.10. No animation. testIDs: `bg-pool-1`, `bg-pool-2`, `bg-pool-3`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/__tests__/AppBackground.test.tsx
import { render } from "@testing-library/react-native";
import { AppBackground } from "../AppBackground";

test("paints the instrument ground with three static pools", async () => {
  const { getByTestId } = await render(<AppBackground />);
  expect(getByTestId("app-background")).toBeTruthy();
  for (const id of ["bg-pool-1", "bg-pool-2", "bg-pool-3"]) {
    expect(getByTestId(id)).toBeTruthy();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/components/__tests__/AppBackground.test.tsx`
Expected: FAIL (missing testIDs or old gradient markup).

- [ ] **Step 3: Reimplement `AppBackground`**

```tsx
// src/components/AppBackground.tsx
import { StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "@/theme";

// Static ambient light pools — the ground the glass refracts. Never animated,
// never behind long text (spec: Tokens > ambient pools).
export function AppBackground() {
  const { instrument, scheme } = useTheme();
  const dark = scheme === "dark";
  const pools = [
    { id: "bg-pool-1", cx: "14%", cy: "4%", color: instrument.accent, opacity: dark ? 0.09 : 0.14 },
    { id: "bg-pool-2", cx: "90%", cy: "44%", color: instrument.teal, opacity: dark ? 0.08 : 0.13 },
    { id: "bg-pool-3", cx: "30%", cy: "96%", color: "#FF9450", opacity: dark ? 0.06 : 0.1 },
  ];
  return (
    <View testID="app-background" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: instrument.bg }]}>
      <Svg width="100%" height="100%">
        <Defs>
          {pools.map((p) => (
            <RadialGradient key={p.id} id={p.id} cx={p.cx} cy={p.cy} r="55%">
              <Stop offset="0" stopColor={p.color} stopOpacity={p.opacity} />
              <Stop offset="1" stopColor={p.color} stopOpacity="0" />
            </RadialGradient>
          ))}
        </Defs>
        {pools.map((p) => (
          <Rect key={p.id} testID={p.id} width="100%" height="100%" fill={`url(#${p.id})`} />
        ))}
      </Svg>
    </View>
  );
}
```

Before replacing: read the current file — if other screens rely on props or the gradients export, preserve those call sites (adjust imports rather than breaking them).

- [ ] **Step 4: Run the component suite and any screen tests that render AppBackground**

Run: `npx jest src/components/__tests__/AppBackground.test.tsx app/__tests__ && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AppBackground.tsx src/components/__tests__/AppBackground.test.tsx
git commit -m "feat(mobile): repaint AppBackground with instrument ambient pools"
```

---

### Task 4: `GaugeDial` — the hero instrument

**Files:**
- Create: `src/components/instrument/GaugeDial.tsx`
- Create: `src/components/instrument/gauge.ts` (shared geometry)
- Test: `src/components/instrument/__tests__/GaugeDial.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument`, `react-native-svg`.
- Produces:
  - `gauge.ts`: `buildGaugeTicks(fraction: number): GaugeTick[]` where `GaugeTick = { x1,y1,x2,y2,width,opacity,red,lit }` — 41 ticks over −205°→+25° in a 264×178 viewBox (center 132,146, outer radius 114), major every 5th, `red` when index/40 > 0.9; and `needleFor(fraction): {x1,y1,x2,y2}` (tail 26 → tip radius−20). Exported constants `GAUGE_VIEW_W = 264`, `GAUGE_VIEW_H = 178`.
  - `GaugeDial({ value, target, burned?, centerLabel = "kcal in reserve", testID? })` — renders the tick arc, needle at `min(value/target, 1)`, scale numerals `0`, `target/2`, `target`, the big remaining numeral (`max(0, target - value)` rounded, mono, tabular), and a footer (Eaten / Burned / Budget) — footer values are the caller's numbers formatted with `toLocaleString()`.
- Tick color logic: lit+red → accent; lit → tickLit (major) / 55% tickLit (minor); unlit+red → accent at 45%; unlit → tick.

- [ ] **Step 1: Write the failing geometry test**

```ts
// in GaugeDial.test.tsx (geometry half)
import { buildGaugeTicks, needleFor } from "../gauge";

test("builds 41 ticks with the redline in the last tenth", () => {
  const ticks = buildGaugeTicks(0.65);
  expect(ticks).toHaveLength(41);
  expect(ticks.filter((t) => t.red)).toHaveLength(4); // indices 37..40
  expect(ticks[26].lit).toBe(true);   // 26/40 = 0.65 — last lit
  expect(ticks[27].lit).toBe(false);
});

test("the needle tracks the fraction monotonically to the right", () => {
  expect(needleFor(0.9).x2).toBeGreaterThan(needleFor(0.2).x2);
});
```

- [ ] **Step 2: Write the failing render test (same file)**

```tsx
import { render } from "@testing-library/react-native";
import { GaugeDial } from "../GaugeDial";

test("shows the remaining energy as the center numeral", async () => {
  const { getByText } = await render(<GaugeDial value={1430} target={2200} burned={304} />);
  expect(getByText("770")).toBeTruthy();
  expect(getByText("kcal in reserve")).toBeTruthy();
  expect(getByText("1,430")).toBeTruthy(); // eaten, footer
  expect(getByText("2,200")).toBeTruthy(); // budget, footer + scale numeral dedupe is fine
});

test("never renders a negative reserve", async () => {
  const { getByText } = await render(<GaugeDial value={2500} target={2200} />);
  expect(getByText("0")).toBeTruthy();
});
```

- [ ] **Step 3: Run tests to verify both fail**

Run: `npx jest src/components/instrument/__tests__/GaugeDial.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement `gauge.ts`**

```ts
// src/components/instrument/gauge.ts
export const GAUGE_VIEW_W = 264;
export const GAUGE_VIEW_H = 178;
const CX = 132, CY = 146, R = 114;
const START = -205, END = 25, TICKS = 40, MAJOR_EVERY = 5;

export interface GaugeTick {
  x1: number; y1: number; x2: number; y2: number;
  width: number; major: boolean; lit: boolean; red: boolean;
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
```

- [ ] **Step 5: Implement `GaugeDial.tsx`**

```tsx
// src/components/instrument/GaugeDial.tsx
import { View } from "react-native";
import Svg, { Circle, Line, Text as SvgText } from "react-native-svg";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { buildGaugeTicks, needleFor, scaleAnchor, GAUGE_VIEW_H, GAUGE_VIEW_W } from "./gauge";

export interface GaugeDialProps {
  value: number;         // eaten kcal
  target: number;        // budget kcal
  burned?: number;
  centerLabel?: string;
  testID?: string;
}

export function GaugeDial({ value, target, burned = 0, centerLabel = "kcal in reserve", testID = "gauge-dial" }: GaugeDialProps) {
  const { instrument, fonts } = useTheme();
  const fraction = target > 0 ? Math.min(value / target, 1) : 0;
  const remaining = Math.max(0, Math.round(target - value));
  const needle = needleFor(fraction);
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };

  const tickColor = (t: { lit: boolean; red: boolean; major: boolean }) => {
    if (t.red) return t.lit ? instrument.accent : `${instrument.accent}73`; // 45% alpha suffix on hex
    if (!t.lit) return instrument.tick;
    return t.major ? instrument.tickLit : instrument.mut;
  };

  return (
    <View testID={testID} accessible accessibilityLabel={`${remaining} calories in reserve of ${target}`}>
      <View style={{ alignItems: "center" }}>
        <Svg width={GAUGE_VIEW_W} height={GAUGE_VIEW_H} viewBox={`0 0 ${GAUGE_VIEW_W} ${GAUGE_VIEW_H}`}>
          {buildGaugeTicks(fraction).map((t, i) => (
            <Line key={i} testID={`gauge-tick-${i}`} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
              stroke={tickColor(t)} strokeWidth={t.width} strokeLinecap="round" />
          ))}
          {[0, 0.5, 1].map((t) => {
            const a = scaleAnchor(t);
            return (
              <SvgText key={t} x={a.x} y={a.y} textAnchor={a.anchor} fontSize={9} fill={instrument.mut}>
                {Math.round(target * t).toLocaleString()}
              </SvgText>
            );
          })}
          <Line testID="gauge-needle" x1={needle.x1} y1={needle.y1} x2={needle.x2} y2={needle.y2}
            stroke={instrument.accent} strokeWidth={3} strokeLinecap="round" />
          <Circle cx={132} cy={146} r={4.5} fill={instrument.accent} />
        </Svg>
        <View style={{ position: "absolute", top: "46%", alignItems: "center" }}>
          <AppText style={[{ fontSize: 54, color: instrument.ink, letterSpacing: -1.5 }, mono]}>{remaining.toLocaleString()}</AppText>
          <AppText style={{ fontSize: 10, letterSpacing: 3, textTransform: "uppercase", color: instrument.accent, marginTop: 6, fontWeight: "600" }}>
            {centerLabel}
          </AppText>
        </View>
      </View>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: instrument.hairline, paddingTop: 12, marginTop: 4 }}>
        {[
          [value, "Eaten"], [burned, "Burned"], [target, "Budget"],
        ].map(([v, k]) => (
          <View key={String(k)} style={{ flex: 1, alignItems: "center" }}>
            <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>{Number(v).toLocaleString()}</AppText>
            <AppText style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: instrument.mut, marginTop: 3 }}>{String(k)}</AppText>
          </View>
        ))}
      </View>
    </View>
  );
}
```

Adjust `AppText` usage to the actual component API (check `src/components/Text.tsx` — if it requires a `variant`, pass `variant="body"` and override with `style`).

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `npx jest src/components/instrument && npx tsc --noEmit`
Expected: PASS.

```bash
git add src/components/instrument
git commit -m "feat(mobile): add GaugeDial hero instrument with redline and scale numerals"
```

---

### Task 5: `SubDial` micro-gauge

**Files:**
- Create: `src/components/instrument/SubDial.tsx`
- Test: `src/components/instrument/__tests__/SubDial.test.tsx`

**Interfaces:**
- Consumes: `useTheme().instrument`.
- Produces: `SubDial({ fraction, size = 42, testID? })` — 25 segments over −225°→+45° in a 44-unit viewBox; segments at `t <= fraction` stroke `instrument.accent`, the rest `instrument.tick`. Used by Home macros (Task 8) and Capture confidence (Task 10).

- [ ] **Step 1: Write the failing test**

```tsx
import { render } from "@testing-library/react-native";
import { SubDial } from "../SubDial";

test("lights segments up to the fraction in accent", async () => {
  const { getByTestId } = await render(<SubDial fraction={0.5} testID="sub" />);
  // 25 segments, indices 0..24; 0.5 → segments 0..12 lit
  expect(getByTestId("sub-seg-0")).toBeTruthy();
  expect(getByTestId("sub-seg-24")).toBeTruthy();
  const lit = getByTestId("sub-seg-12").props.stroke;
  const unlit = getByTestId("sub-seg-13").props.stroke;
  expect(lit).not.toEqual(unlit);
});

test("clamps out-of-range fractions", async () => {
  const { getByTestId } = await render(<SubDial fraction={1.7} testID="sub" />);
  expect(getByTestId("sub-seg-24").props.stroke).toEqual(getByTestId("sub-seg-0").props.stroke);
});
```

(If `stroke` arrives as a processed color object, compare with the `processColor` helper pattern from `BrandMark.test.tsx`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/components/instrument/__tests__/SubDial.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

```tsx
// src/components/instrument/SubDial.tsx
import Svg, { Line } from "react-native-svg";
import { useTheme } from "@/theme";

export interface SubDialProps { fraction: number; size?: number; testID?: string }

export function SubDial({ fraction, size = 42, testID = "subdial" }: SubDialProps) {
  const { instrument } = useTheme();
  const f = Math.min(Math.max(fraction, 0), 1);
  const C = 22, R = 17, START = -225, END = 45, SEG = 24;
  const lines = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const a = ((START + t * (END - START)) * Math.PI) / 180;
    lines.push(
      <Line key={i} testID={`${testID}-seg-${i}`}
        x1={C + (R - 4) * Math.cos(a)} y1={C + (R - 4) * Math.sin(a)}
        x2={C + R * Math.cos(a)} y2={C + R * Math.sin(a)}
        stroke={t <= f ? instrument.accent : instrument.tick}
        strokeWidth={1.6} strokeLinecap="round" />,
    );
  }
  return <Svg width={size} height={size} viewBox="0 0 44 44" testID={testID}>{lines}</Svg>;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx jest src/components/instrument && npx tsc --noEmit
git add src/components/instrument
git commit -m "feat(mobile): add SubDial micro-gauge"
```

---

### Task 6: `TeleStrip`, `MacroWide`, `StreakCells`, `EnergyBars`

Four small presentational components in one task — they share no logic but land together because Home/Trends need them as a set.

**Files:**
- Create: `src/components/instrument/TeleStrip.tsx`
- Create: `src/components/instrument/MacroWide.tsx`
- Create: `src/components/instrument/StreakCells.tsx`
- Create: `src/components/instrument/EnergyBars.tsx`
- Test: `src/components/instrument/__tests__/strips.test.tsx`

**Interfaces:**
- Consumes: `GlassPanel` (Task 2), `SubDial` (Task 5), `useTheme().instrument`.
- Produces:
  - `TeleStrip({ cells: Array<{ icon: ReactNode; value: string; label: string }> })` — one GlassPanel, cells divided by 1px hairlines.
  - `MacroWide({ label, value, goal, unit = "g" })` — GlassPanel row: SubDial(fraction=value/goal) + engraved label + mono `value / goal` + progress bar (inset track, accent fill) + mono "`N`g to go" (`max(0, goal - value)`).
  - `StreakCells({ hits: boolean[] })` — 7 cells; hit = accent, miss = tick.
  - `EnergyBars({ days: Array<{ label: string; fraction: number; over: boolean }>, targetFraction?: number = 0.74 })` — bars in a GlassPanel-less View (the parent panel wraps it); `over` bars accent, others tickLit at 72% opacity; dashed target line via a bordered View at `top: (1 - targetFraction) * 100%`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/instrument/__tests__/strips.test.tsx
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { TeleStrip } from "../TeleStrip";
import { MacroWide } from "../MacroWide";
import { StreakCells } from "../StreakCells";
import { EnergyBars } from "../EnergyBars";

test("TeleStrip renders every cell's value and label", async () => {
  const { getByText } = await render(
    <TeleStrip cells={[
      { icon: <Text>i</Text>, value: "8,432", label: "Steps" },
      { icon: <Text>i</Text>, value: "7:12", label: "Sleep" },
    ]} />,
  );
  expect(getByText("8,432")).toBeTruthy();
  expect(getByText("Sleep")).toBeTruthy();
});

test("MacroWide shows the shortfall, never a negative", async () => {
  const over = await render(<MacroWide label="Protein" value={150} goal={140} />);
  expect(over.getByText("0g to go")).toBeTruthy();
  const under = await render(<MacroWide label="Protein" value={96} goal={140} />);
  expect(under.getByText("44g to go")).toBeTruthy();
});

test("StreakCells marks hits distinctly from misses", async () => {
  const { getByTestId } = await render(<StreakCells hits={[true, false, true, true, false, true, true]} />);
  const hit = getByTestId("streak-0").props.style;
  const miss = getByTestId("streak-1").props.style;
  expect(JSON.stringify(hit)).not.toEqual(JSON.stringify(miss));
});

test("EnergyBars renders one bar per day plus the target line", async () => {
  const days = ["Tu", "We", "Th"].map((label, i) => ({ label, fraction: 0.6 + i * 0.2, over: i === 2 }));
  const { getByTestId } = await render(<EnergyBars days={days} />);
  for (let i = 0; i < 3; i++) expect(getByTestId(`ebar-${i}`)).toBeTruthy();
  expect(getByTestId("ebar-target")).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail** — `npx jest src/components/instrument/__tests__/strips.test.tsx` → FAIL.

- [ ] **Step 3: Implement the four components**

Follow the prototype's proportions exactly (`kora-instrument-glass.html` in the session scratchpad mirrors them; the spec is normative for colors). Sketch:

```tsx
// TeleStrip.tsx (core layout)
<GlassPanel radius={20}>
  <View style={{ flexDirection: "row", alignItems: "center", padding: 13, paddingHorizontal: 18 }}>
    {cells.map((c, i) => (
      <Fragment key={c.label}>
        {i > 0 && <View style={{ width: 1, height: 30, backgroundColor: instrument.hairline, marginHorizontal: 16 }} />}
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: instrument.inset, borderWidth: 1, borderColor: instrument.glassBorder, alignItems: "center", justifyContent: "center" }}>{c.icon}</View>
          <View>
            <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>{c.value}</AppText>
            <AppText style={engraved}>{c.label}</AppText>
          </View>
        </View>
      </Fragment>
    ))}
  </View>
</GlassPanel>
```

`MacroWide`: GlassPanel radius 22, row of `SubDial fraction={value/goal}`, label+value column, flex progress bar (`height 5`, track `instrument.inset`, fill width `${Math.min(value/goal,1)*100}%` accent), trailing `"${Math.max(0, goal - value)}${unit} to go"` in mut 11px mono.

`StreakCells`: row of 7 Views `flex:1 height:26 borderRadius:6`, `backgroundColor: hit ? instrument.accent : instrument.tick`, `testID="streak-{i}"`, `gap: 5`.

`EnergyBars`: relative View height 86; absolute dashed line (`borderTopWidth: 1.5, borderStyle: "dashed", borderColor: instrument.tick`, testID `ebar-target`) at `top: `${(1 - targetFraction) * 100}%``; bars `testID="ebar-{i}"` with `height: `${fraction * 100}%``, `backgroundColor: over ? instrument.accent : instrument.tickLit`, `opacity: over ? 1 : 0.72`, `borderRadius: 6` — plus a label row underneath (9px engraved).

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npx jest src/components/instrument && npx tsc --noEmit
git add src/components/instrument
git commit -m "feat(mobile): add TeleStrip, MacroWide, StreakCells and EnergyBars"
```

---

### Task 7: `GlassTabBar` and tab renames

**Files:**
- Modify: `src/components/FloatingTabBar.tsx` (read fully first — it is wired into `app/(tabs)/_layout.tsx`)
- Modify: `app/(tabs)/_layout.tsx` (tab titles: Today / Diary / Trends / More)
- Test: extend `app/__tests__/tabs-layout.test.tsx`

**Interfaces:**
- Consumes: `GlassPanel` material recipe (inline BlurView is fine here — the tab bar is its own glass layer), `useTheme().instrument`, existing tab-bar props from expo-router (`BottomTabBarProps` or the custom contract the file already uses — preserve it).
- Produces: same component export (`FloatingTabBar`) so `_layout.tsx` wiring is unchanged; visual contract: glass pill (radius 32, height 64), engraved labels, 4pt accent dot above the active label (testID `tab-dot-active`), center capture button 52pt accent circle (existing navigation handler kept).

- [ ] **Step 1: Write the failing test (extend tabs-layout.test.tsx)**

```tsx
test("the active tab carries the accent dot and tabs use the new names", async () => {
  const ui = await renderTabs(); // reuse the file's existing render helper
  expect(ui.getByText("Today")).toBeTruthy();
  expect(ui.getByText("Trends")).toBeTruthy();
  expect(ui.queryByText("Progress")).toBeNull();
  expect(ui.getByTestId("tab-dot-active")).toBeTruthy();
});
```

Match the helper/queries actually present in the existing test file — read it first and follow its patterns (it already renders the tab layout).

- [ ] **Step 2: Run to verify it fails** — `npx jest app/__tests__/tabs-layout.test.tsx` → FAIL.

- [ ] **Step 3: Restyle `FloatingTabBar` + rename titles in `_layout.tsx`**

Keep the component's route-handling logic byte-for-byte; replace only the visual shell: outer wrapper absolute bottom 24 / left 24 / right 24, BlurView + `instrument.glass` fill + border `instrument.glassBorder` radius 32; labels 9px, letterSpacing 1.4, uppercase, `instrument.mut` (active: `instrument.ink`); active dot `width/height 4, borderRadius 2, backgroundColor instrument.accent, marginBottom 6, testID="tab-dot-active"`; capture button `52×52, borderRadius 26, backgroundColor instrument.accent`, icon color `instrument.accentOn`, keep its existing `onPress`/haptic.

In `app/(tabs)/_layout.tsx`, set titles: `index → "Today"`, `diary → "Diary"`, `progress → "Trends"`, `more → "More"`. Do not rename route files.

- [ ] **Step 4: Run tests, typecheck** — `npx jest app/__tests__/tabs-layout.test.tsx && npx tsc --noEmit` → PASS. Also run the full suite: other tests may query "Progress".

- [ ] **Step 5: Commit**

```bash
git add src/components/FloatingTabBar.tsx "app/(tabs)/_layout.tsx" app/__tests__/tabs-layout.test.tsx
git commit -m "feat(mobile): restyle tab bar as instrument glass and rename Progress to Trends"
```

---

### Task 8: Home screen rebuild

**Files:**
- Modify: `app/(tabs)/index.tsx`
- Modify: `src/components/home/KcalHero.tsx` → superseded by `GaugeDial`; delete only if no other screen imports it (grep first)
- Test: extend `app/__tests__/` home tests (locate the file with `grep -rl "KcalHero\|useDashboard" app/__tests__`)

**Interfaces:**
- Consumes: `GaugeDial` (Task 4), `MacroWide`, `SubDial`, `TeleStrip` (Tasks 5–6), `GlassPanel`, existing hooks `useProfile/useDashboard/useDayLogs/useUnreadCount/useHealth` — untouched.
- Produces: Home layout per spec §Screens.1. Data mapping: `value = d.consumed.kcal`, `target = d.targets.kcal`, protein `d.consumed.protein_g / d.targets.protein_g` (verify exact field names in `src/api/types.ts` before coding — adjust to reality, the hooks do not change).

- [ ] **Step 1: Update the screen test first** — assert the new structure: `gauge-dial` present, protein MacroWide text ("44g to go" style), "Logged today" section label, meal rows with mono kcal. Run → FAIL.
- [ ] **Step 2: Rebuild the JSX** in `app/(tabs)/index.tsx` following the prototype order: header (date sentence-case · greeting, avatar) → `GlassPanel><GaugeDial …/>` with engraved "Energy reserve" caption → `MacroWide` protein → two compact `GlassPanel` SubDial cards (carbs, fat) → `TeleStrip` (steps from `health`, sleep) → "Logged today" (14px semibold + hairline ::after equivalent — a flex row with a 1px View) → meal rows (keep `openMeal` handler and `MealRow` or restyle rows inline with mono time/kcal). Keep the first-mount-only entrance stagger exactly as-is.
- [ ] **Step 3: Run the screen test + full suite + typecheck** → PASS.
- [ ] **Step 4: Manual gate** — boot the iPhone 17 Pro simulator (never the Pro Max), screenshot Home in dark; verify gauge, asymmetric macros, pools visible but subtle.
- [ ] **Step 5: Commit**

```bash
git add "app/(tabs)/index.tsx" src/components app/__tests__
git commit -m "feat(mobile): rebuild Home in instrument glass"
```

---

### Task 9: Diary screen rebuild

**Files:**
- Modify: `app/(tabs)/diary.tsx` (read fully; keep data hooks and day-selection state)
- Test: extend the existing diary screen test (locate via `grep -rl "diary" app/__tests__ src --include="*.test.tsx"`)

**Interfaces:**
- Consumes: `GlassPanel`, `useTheme().instrument`; existing diary data hooks unchanged.
- Produces: week strip (7 cells, selected = GlassPanel-look cell, pip = 4pt dot accent when day hit goal), day-total readout row (engraved "Day total", mono `eaten / target`, inset track with accent fill), per-slot GlassPanels with slot-engraved headers and mono totals, ghost "Add dinner · N kcal in reserve" row (1.5px dashed `instrument.tick` border, accent "+") that routes to the existing add-meal flow for that slot.

- [ ] **Step 1: Update the diary test** — week strip cells render, selected day marked, slots grouped, ghost row present with reserve figure. Run → FAIL.
- [ ] **Step 2: Rebuild the JSX** per prototype; reuse the screen's existing grouping logic for slots (do not re-derive; restyle).
- [ ] **Step 3: Tests + typecheck + full suite** → PASS.
- [ ] **Step 4: Simulator screenshot gate (dark).**
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): rebuild Diary in instrument glass"`

---

### Task 10: Capture screen restyle (always dark)

**Files:**
- Modify: `app/capture.tsx` (large file — restyle chrome only; capture pipeline, permissions, offline queue logic untouched)
- Modify: `src/components/capture/DetectedCard.tsx` (or the actual detected-card component — confirm via imports in capture.tsx)
- Test: extend existing capture tests (`app/__tests__` + `src/components/capture/__tests__`)

**Interfaces:**
- Consumes: `SubDial` (confidence), `INSTRUMENT_DARK_FIXED` from `@/theme` (Task 1) — capture styles from this constant, NOT from `useTheme().instrument`, so it stays dark in light mode.
- Produces: lume reticle corners (4 Views, 2.5px borders, 34pt, radius 10 on the outer corner) + accent scan line (1.5px, horizontal, static) overlaying the viewfinder; mode chips glass-styled; DetectedCard = dark glass panel with `SubDial fraction={confidence}` + name + mono "~N kcal · M% match" + accent "Log it" button (keep the existing confirm handler).

- [ ] **Step 1: Update tests** — DetectedCard renders confidence SubDial and "Log it"; capture screen ignores light scheme (assert a style uses `INSTRUMENT_DARK_FIXED.bg`). Run → FAIL.
- [ ] **Step 2: Restyle** — chrome only; grep for the four mode names to find the chip row.
- [ ] **Step 3: Tests + typecheck + full suite** → PASS.
- [ ] **Step 4: Simulator gate** — capture screen in BOTH themes; verify identical (dark).
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): restyle capture chrome in fixed dark instrument glass"`

---

### Task 11: Trends screen rebuild

**Files:**
- Modify: `app/(tabs)/progress.tsx`
- Test: extend existing progress/trends screen test

**Interfaces:**
- Consumes: `GlassPanel`, `EnergyBars`, `StreakCells` (Task 6), existing `Sparkline` component (restyle stroke to `instrument.accent`, add end-dot if it lacks one) or inline SVG polyline; data hooks unchanged.
- Produces: glass segmented control (Week/Month/6M — keep existing period state), Weight panel (engraved "Weight", accent mono delta "▾ 0.6 kg", 34px mono headline, accent sparkline + 10% area fill + end dot), Energy panel (`EnergyBars` + legend: in-budget / over / target), duo of Protein-goal and Avg-sleep panels with `StreakCells`.

- [ ] **Step 1: Update test** (segmented present, weight headline mono, `ebar-*` bars render, streaks render). Run → FAIL.
- [ ] **Step 2: Rebuild JSX**; compute `over` per day from existing dashboard data (eaten > target).
- [ ] **Step 3: Tests + typecheck + full suite** → PASS.
- [ ] **Step 4: Simulator gate (dark).**
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): rebuild Trends in instrument glass"`

---

### Task 12: Meal detail rebuild

**Files:**
- Modify: `app/meal.tsx`
- Test: extend existing meal screen test

**Interfaces:**
- Consumes: `GlassPanel`, `useTheme().instrument`; existing route params and mutation handlers unchanged.
- Produces: header (glass back button, slot·time engraved, name 22px), provenance chips (`ProvenanceChip` restyled or inline: glass chip, accent "◉" + "Photo · AI estimate"; mono grams chip), kcal hero panel (64px mono numeral, engraved "kcal · this meal", "N% of today's budget" in mut — percent = kcal/target from dashboard if available, else omit the line), macro rows (engraved label 70pt column / inset 5px track with accent fill / mono value + "· N%" mut), portion panel (engraved "Portion", mono grams, stepper: bordered `instrument.glassBorder` pill, accent −/+, mono multiplier — wire to the existing portion state from the units/portion work), accent primary "Looks right — keep it" (routes to existing confirm/save), actions row Edit / Duplicate / Delete (Delete text `instrument.danger`).

- [ ] **Step 1: Update test** (hero numeral, provenance chip, macro rows, danger delete). Run → FAIL.
- [ ] **Step 2: Rebuild JSX.**
- [ ] **Step 3: Tests + typecheck + full suite** → PASS.
- [ ] **Step 4: Simulator gate (dark).**
- [ ] **Step 5: Commit** — `git commit -m "feat(mobile): rebuild meal detail in instrument glass"`

---

### Task 13: Enable light theme + motion/a11y polish

**Files:**
- Modify: `app.json` (`userInterfaceStyle: "dark"` → `"automatic"`)
- Modify: any in-scope screen found still hardcoding dark assumptions (audit pass)
- Test: extend `src/theme/__tests__/instrument.test.ts` and screen tests that mock `useColorScheme`

**Interfaces:**
- Consumes: everything above.
- Produces: the app renders both themes on the five rebuilt screens; capture stays dark; needle/tick changes animate with reanimated springs (damping 1.0, ~350ms response) and respect Reduce Motion (`useReducedMotion` from reanimated → skip sweep, jump-cut).

- [ ] **Step 1: Write the failing theme-switch test** — mock `useColorScheme` to "light" in a Home screen test variant; assert the background uses `#ECEDEF` (query `app-background` style) and the gauge still renders. Run → FAIL (app.json flip not needed for the test; the mock drives it).
- [ ] **Step 2: Flip `app.json` to `"automatic"`; audit the five screens** for `darkColors`/hex literals that should be `instrument.*`; fix.
- [ ] **Step 3: Add the needle spring** in `GaugeDial` (`useAnimatedProps` on the needle Line with `withSpring(fraction, { damping: 30, stiffness: 250 })` equivalents; gate with `useReducedMotion()`); extend the GaugeDial test only for the reduced-motion branch rendering statically.
- [ ] **Step 4: Full suite + typecheck** → PASS.
- [ ] **Step 5: Manual gate** — iPhone 17 Pro simulator: all five screens × light + dark × Reduce Transparency on/off; contrast spot-check ink-on-glass.
- [ ] **Step 6: Commit** — `git commit -m "feat(mobile): enable automatic light theme with instrument glass polish"`

---

### Task 14: Retire dead legacy pieces

**Files:**
- Delete: `src/components/home/KcalHero.tsx`, `src/components/GaugeRing.tsx`, `src/components/RingStat.tsx` — ONLY those with zero remaining imports (grep each; out-of-scope screens may still use `RingStat` — if so, leave it and note it)
- Modify: remove `sleepMetric`/`stepsMetric` purple/lime from `palette.ts` if no remaining references
- Test: full suite

- [ ] **Step 1: Grep each candidate** (`grep -rn "KcalHero\|GaugeRing\|RingStat\|sleepMetric\|stepsMetric" app src --include="*.ts*"`); delete only zero-reference files/keys.
- [ ] **Step 2: Full suite + typecheck** → PASS.
- [ ] **Step 3: Commit** — `git commit -m "chore(mobile): remove legacy hero and ring components superseded by instrument glass"`

---

## Self-review notes

- Spec coverage: tokens → T1; material+a11y → T2; pools → T3; GaugeDial → T4; SubDial → T5; TeleStrip/MacroWide/StreakCells/EnergyBars → T6; GlassTabBar+rename → T7; five screens → T8–T12; theme flip + motion + gates → T13; legacy retirement → T14. Out-of-scope items (onboarding, social, settings, widgets, illustrations) intentionally have no tasks.
- Screen tasks (8–12) direct the implementer to read the existing screen/test files and preserve data logic; exact hook fields are verified against `src/api/types.ts` at implementation time rather than guessed here.
- Type consistency: `instrument` token keys, `GaugeDial`/`SubDial` props, and `INSTRUMENT_DARK_FIXED` are named identically everywhere they appear.
