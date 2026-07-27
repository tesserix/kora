# Kora — Elevated Dashboards + Real Apple Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elevate the whole mobile app to a premium wellness look (filled gradient rings, color-per-signal tiles, sparklines, depth) and replace every fabricated metric with real data — Apple Health (steps + sleep, client-only) and a real 7-day average intake.

**Architecture:** Mobile-only. A new elevated primitive kit in `src/components/` (tokens + `GaugeRing`, `MacroBars` v2, `RingStat`, `Sparkline`, `StreakBars`, elevated `Card`, `MealRow`/`LeaderRow`/`NotifRow`) is built and unit-tested first, then swapped into behavior-bearing screens in a pure visual pass that preserves every payload, consent gate, testID, and a11y label. Real data lands last: a client-only `useHealth()` reading HealthKit and a client-only `useAvgIntake7d()` computed from the existing dashboard, both degrading honestly (never a fabricated number).

**Tech Stack:** React Native / Expo SDK 57, TypeScript, react-native-reanimated 4, **react-native-svg 15** (all gradients — no new gradient dependency), @tanstack/react-query 5 (`useQueries` for the 7-day fan-out), `@kingstinct/react-native-healthkit` (Phase 4 only).

## Global Constraints

- **Branch:** all work on `elevated-v2` off `main` (`6f93c7b`).
- **Mobile-only.** No `src/api/` request shapes, no backend, no new tables. Phase 4 adds only client-side read code (`src/health/`, two read-only hooks reusing existing endpoints).
- **Gradients via `react-native-svg` only** (already installed, jest-proven). Do **not** add `expo-linear-gradient`. This keeps Phases 1–3 renderable on the current dev-client with no native rebuild; only Phase 4 (HealthKit) triggers a rebuild.
- **Tokens-only in screens.** Raw hex lives only in `src/theme/palette.ts` and `src/components/capture/captureTheme.ts`. Everything else reads from `useTheme()`.
- **HARD INVARIANT — no fabricated numbers, ever.** Steps/Sleep render a "Connect Apple Health" affordance whenever `useHealth().status !== 'authorized'` — never a number in that state. Avg intake renders `—` when fewer than 1 day of data exists. The three hardcoded fake strings in `app/(tabs)/progress.tsx` (`"1,921"`, `"8,240"`, `"7.1"`) must be gone by end of Phase 2.
- **Preserve behavior.** Every mutation payload, consent gate (metrics only for `share_progress` users), testID, and **verbatim** a11y label is unchanged across the restyle. Prove it with the existing invariant/proof tests passing **unmodified**.
- **Animation safety.** Never call a JS function inside a worklet (the AnimatedNumber-on-UI-runtime crash class, `e557c503`). Animate only numbers on the UI thread; format on the JS thread at render. Reduced-motion seeds the settled value on first paint (no tween). Device-verify every animated component in Phase 5 (jest cannot catch worklet-runtime crashes).
- **Per-task gate:** `cd apps/mobile && npx tsc --noEmit && npm test -- --ci` — run **foreground**, both green, before commit.
- **Commits:** single-line conventional (`feat(ui):`, `feat(health):`, `refactor(ui):`, `test:`, `chore:`). No signature. **Never `git add -A`** (untracked `.idea/`) — stage explicit paths.
- **Existing theme surface** (do not change its shape, only extend): `useTheme()` returns `{ colors, spacing, radius, fontSize, fonts, shadows, scheme, type }`. `springs = { instant, standard, lively }`. `useMotionPrefs()` returns `{ reduceMotion }`.

---

## Phase 1 — Elevated primitive kit

### Task 1: Token additions (metric hues, green gradient stops, elevated surface + shadow)

**Files:**
- Modify: `src/theme/palette.ts`
- Modify: `src/theme/index.ts`
- Test: `src/theme/__tests__/palette.test.ts` (extend)

**Interfaces:**
- Produces: `lightColors`/`darkColors` gain keys `stepsMetric`, `sleepMetric`, `elevated`. New export `gradientStops: { light: GradientSet; dark: GradientSet }` where `GradientSet = { green: [string, string]; steps: [string, string]; sleep: [string, string] }`. `useTheme()` return gains `gradients: GradientSet` (scheme-selected) and `shadows.card` (a real soft elevation shadow).

- [ ] **Step 1: Write the failing test** — append to `src/theme/__tests__/palette.test.ts`:

```typescript
import { lightColors, darkColors, gradientStops } from "../palette";

describe("elevated tokens", () => {
  it("adds metric hues + elevated surface to both schemes", () => {
    for (const c of [lightColors, darkColors]) {
      expect(c.stepsMetric).toMatch(/^#/);
      expect(c.sleepMetric).toMatch(/^#/);
      expect(c.elevated).toMatch(/^#/);
    }
  });
  it("exposes 2-stop gradient sets per scheme", () => {
    for (const scheme of [gradientStops.light, gradientStops.dark]) {
      for (const pair of [scheme.green, scheme.amber, scheme.blue, scheme.steps, scheme.sleep]) {
        expect(pair).toHaveLength(2);
        expect(pair[0]).toMatch(/^#/);
        expect(pair[1]).toMatch(/^#/);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/theme/__tests__/palette.test.ts`
Expected: FAIL — `gradientStops` is not exported; `stepsMetric` undefined.

- [ ] **Step 3: Add tokens to `src/theme/palette.ts`** — inside `lightColors` add (before the closing `} as const`):

```typescript
  stepsMetric: "#8FD400",
  sleepMetric: "#7A6BFF",
  elevated: "#FFFFFF",
```

Inside `darkColors` add the matching keys:

```typescript
  stepsMetric: "#B6FF3D",
  sleepMetric: "#8B7CFF",
  elevated: "#2C2C2E",
```

Then, after the `darkColors` block, add:

```typescript
export type GradientSet = {
  green: [string, string];
  amber: [string, string];
  blue: [string, string];
  steps: [string, string];
  sleep: [string, string];
};

// 2-stop [bright, deep] gradient pairs per scheme, tuned so the arc reads as a
// filled sweep. Green stays the hero; amber/blue power the carbs/fat macro
// fills; steps=lime, sleep=violet mirror the metric hues above.
export const gradientStops: { light: GradientSet; dark: GradientSet } = {
  light: {
    green: ["#34C759", "#1E9E4A"],
    amber: ["#FFB340", "#F08C00"],
    blue: ["#4DA2FF", "#0A63D6"],
    steps: ["#A6E635", "#6FA800"],
    sleep: ["#8E82FF", "#5E4FE0"],
  },
  dark: {
    green: ["#3DDC6E", "#12A150"],
    amber: ["#FFC15E", "#FF9F0A"],
    blue: ["#6FB6FF", "#0A84FF"],
    steps: ["#C4FF5E", "#8FD400"],
    sleep: ["#9E90FF", "#6E5FE8"],
  },
};
```

- [ ] **Step 4: Surface `gradients` + `shadows.card` in `src/theme/index.ts`** — import `gradientStops`, add a `card` shadow, and return `gradients`:

In the import line add `gradientStops`:

```typescript
import { darkColors, fontSize, gradientStops, lightColors, radius, spacing, type } from "./palette";
```

In `makeShadows`, add a `card` entry (a real, visible-but-soft elevation for cards):

```typescript
    card: { shadowColor, shadowOpacity: scheme === "dark" ? 0.4 : 0.1, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
```

In `useTheme()`, add `gradients` to the returned object:

```typescript
  const gradients = scheme === "dark" ? gradientStops.dark : gradientStops.light;
  return { colors, spacing, radius, fontSize, fonts, shadows: makeShadows(scheme), scheme, type, gradients } as const;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --ci src/theme/__tests__/palette.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/theme/palette.ts src/theme/index.ts src/theme/__tests__/palette.test.ts
git commit -m "feat(ui): elevated tokens — metric hues, green gradient stops, card shadow"
```

---

### Task 2: `GaugeRing` — filled gradient arc primitive

**Files:**
- Create: `src/components/GaugeRing.tsx`
- Test: `src/components/__tests__/GaugeRing.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` (`colors`, `gradients`), `springs`, `useMotionPrefs` (Task 1 + existing).
- Produces: `GaugeRing({ value, max, size?, stroke?, gradient?, color?, track?, children }: { value: number; max: number; size?: number; stroke?: number; gradient?: [string, string]; color?: string; track?: string; children?: ReactNode })`. Renders an SVG ring: faint track + rounded-cap filled arc. If `gradient` is passed it fills with an SVG `LinearGradient`; else solid `color` (default `colors.primary`). Arc animates `strokeDashoffset` from current→target (numbers only — worklet-safe). `max <= 0` renders an empty arc (offset === full circumference). Reduced-motion seeds the settled offset on first paint. Arc has `testID="gauge-arc"`.

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/GaugeRing.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { GaugeRing } from "../GaugeRing";

const circ = (size: number, stroke: number) => 2 * Math.PI * ((size - stroke) / 2);

describe("GaugeRing", () => {
  it("renders children centered", async () => {
    const { getByText } = await render(
      <GaugeRing value={50} max={100}><Text>1,200</Text></GaugeRing>,
    );
    expect(getByText("1,200")).toBeTruthy();
  });

  it("half-full arc offsets by half the circumference", async () => {
    const size = 72, stroke = 8;
    const { getByTestId } = await render(<GaugeRing value={50} max={100} size={size} stroke={stroke} />);
    const arc = getByTestId("gauge-arc");
    expect(arc.props.strokeDashoffset).toBeCloseTo(circ(size, stroke) * 0.5, 1);
  });

  it("max<=0 renders an empty arc (fully offset)", async () => {
    const size = 72, stroke = 8;
    const { getByTestId } = await render(<GaugeRing value={5} max={0} size={size} stroke={stroke} />);
    const arc = getByTestId("gauge-arc");
    expect(arc.props.strokeDashoffset).toBeCloseTo(circ(size, stroke), 1);
  });

  it("uses a gradient stroke when a gradient pair is provided", async () => {
    const { UNSAFE_getByProps } = await render(
      <GaugeRing value={50} max={100} gradient={["#3DDC6E", "#12A150"]} />,
    );
    // arc stroke references the gradient def
    expect(UNSAFE_getByProps({ testID: "gauge-arc" }).props.stroke).toContain("url(#");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/GaugeRing.test.tsx`
Expected: FAIL — `Cannot find module '../GaugeRing'`.

- [ ] **Step 3: Write `src/components/GaugeRing.tsx`**:

```tsx
import type { ReactNode } from "react";
import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import Animated, { useAnimatedProps, useSharedValue, withSpring } from "react-native-reanimated";
import { useTheme } from "@/theme";
import { springs, useMotionPrefs } from "@/motion";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  gradient?: [string, string];
  color?: string;
  track?: string;
  children?: ReactNode;
};

// Filled gradient progress ring. Animates only strokeDashoffset (a number) on
// the UI thread — no JS fn ever runs in a worklet (AnimatedNumber crash class).
// Reduced motion seeds the settled offset so the first paint is correct.
export function GaugeRing({ value, max, size = 72, stroke = 8, gradient, color, track, children }: Props) {
  const { colors } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const gid = useId();
  const trackColor = track ?? colors.muted;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const half = size / 2;
  const targetOffset = circumference * (1 - pct);
  const strokeColor = gradient ? `url(#${gid})` : (color ?? colors.primary);

  const offset = useSharedValue(targetOffset);
  useEffect(() => {
    offset.value = reduceMotion ? targetOffset : withSpring(targetOffset, springs.standard);
  }, [targetOffset, reduceMotion, offset]);

  const animatedProps = useAnimatedProps(() => ({ strokeDashoffset: offset.value }));

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {gradient ? (
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0%" stopColor={gradient[0]} />
              <Stop offset="100%" stopColor={gradient[1]} />
            </LinearGradient>
          </Defs>
        ) : null}
        <Circle cx={half} cy={half} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
        <AnimatedCircle
          testID="gauge-arc"
          cx={half}
          cy={half}
          r={r}
          stroke={strokeColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          animatedProps={animatedProps}
          transform={`rotate(-90 ${half} ${half})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>{children}</View>
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/GaugeRing.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/GaugeRing.tsx src/components/__tests__/GaugeRing.test.tsx
git commit -m "feat(ui): GaugeRing — filled gradient progress ring primitive"
```

---

### Task 3: `MacroBars` v2 — SVG gradient fills

**Files:**
- Modify: `src/components/home/MacroBars.tsx`
- Test: `src/components/__tests__/dashboard-widgets.test.tsx` (extend — this file already tests ProvenanceChip; add MacroBars cases)

**Interfaces:**
- Consumes: `useTheme()` (`colors`, `gradients`, `radius`), `springs`, `useMotionPrefs`.
- Produces: same public API — `MacroBars({ macros }: { macros: Macros })` and `export interface Macros { p; c; f; pGoal; cGoal; fGoal }` unchanged. Each bar now renders as an SVG track + animated gradient-filled rounded rect (`preserveAspectRatio="none"`, viewBox width 100 = percent). Protein=green gradient, Carbs=amber, Fat=blue. Gram labels stay tabular. Fill rect has `testID="macro-fill-<label lowercased>"`.

- [ ] **Step 1: Write the failing test** — append to `src/components/__tests__/dashboard-widgets.test.tsx`:

```tsx
import { MacroBars } from "@/components/home/MacroBars";

describe("MacroBars v2", () => {
  it("renders three gradient fills sized to each macro percent", async () => {
    const { getByTestId } = await render(
      <MacroBars macros={{ p: 50, c: 100, f: 20, pGoal: 100, cGoal: 200, fGoal: 40 }} />,
    );
    // 50/100 → width 50 in a 0..100 viewBox
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-carbs").props.width).toBeCloseTo(50, 1);
    expect(getByTestId("macro-fill-fat").props.width).toBeCloseTo(50, 1);
  });
  it("clamps over-goal to 100 and shows gram labels", async () => {
    const { getByTestId, getByText } = await render(
      <MacroBars macros={{ p: 200, c: 0, f: 0, pGoal: 100, cGoal: 200, fGoal: 40 }} />,
    );
    expect(getByTestId("macro-fill-protein").props.width).toBeCloseTo(100, 1);
    expect(getByText("200g / 100g")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/dashboard-widgets.test.tsx`
Expected: FAIL — no `macro-fill-protein` testID.

- [ ] **Step 3: Rewrite `src/components/home/MacroBars.tsx`**:

```tsx
import { useEffect, useId } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import Animated, { useAnimatedProps, useSharedValue, withSpring } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { springs, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";

export interface Macros {
  p: number;
  c: number;
  f: number;
  pGoal: number;
  cGoal: number;
  fGoal: number;
}

const AnimatedRect = Animated.createAnimatedComponent(Rect);
const BAR_H = 8;

interface BarProps {
  label: string;
  value: number;
  goal: number;
  gradient: [string, string];
}

function Bar({ label, value, goal, gradient }: BarProps) {
  const { colors } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const gid = useId();
  const pct = goal > 0 ? Math.min(100, Math.max(0, (value / goal) * 100)) : 0;
  const w = useSharedValue(pct);

  useEffect(() => {
    w.value = reduceMotion ? pct : withSpring(pct, springs.standard);
  }, [pct, reduceMotion, w]);

  const animatedProps = useAnimatedProps(() => ({ width: w.value }));
  const key = label.toLowerCase();

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <AppText variant="footnote" muted>{label}</AppText>
        <AppText variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
          {`${Math.round(value)}g / ${Math.round(goal)}g`}
        </AppText>
      </View>
      {/* viewBox width 100 == percent; preserveAspectRatio none lets it stretch full width */}
      <Svg width="100%" height={BAR_H} viewBox={`0 0 100 ${BAR_H}`} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0%" stopColor={gradient[0]} />
            <Stop offset="100%" stopColor={gradient[1]} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={100} height={BAR_H} rx={BAR_H / 2} fill={colors.muted} />
        <AnimatedRect testID={`macro-fill-${key}`} x={0} y={0} height={BAR_H} rx={BAR_H / 2} fill={`url(#${gid})`} animatedProps={animatedProps} />
      </Svg>
    </View>
  );
}

// Three macro bars (protein/carbs/fat) with SVG gradient fills — tokens only.
export function MacroBars({ macros }: { macros: Macros }) {
  const { gradients } = useTheme();
  return (
    <View style={{ gap: 12, marginTop: 16 }}>
      <Bar label="Protein" value={macros.p} goal={macros.pGoal} gradient={gradients.green} />
      <Bar label="Carbs" value={macros.c} goal={macros.cGoal} gradient={gradients.amber} />
      <Bar label="Fat" value={macros.f} goal={macros.fGoal} gradient={gradients.blue} />
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/dashboard-widgets.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/home/MacroBars.tsx src/components/__tests__/dashboard-widgets.test.tsx
git commit -m "feat(ui): MacroBars v2 — SVG gradient fills, tabular labels"
```

---

### Task 4: `RingStat` tile — value / empty / connect-Health states

**Files:**
- Create: `src/components/RingStat.tsx`
- Test: `src/components/__tests__/RingStat.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`, `GaugeRing` (Task 2), `AppText`, `Numeral`, `Icon`.
- Produces: `RingStat(props: RingStatProps)` where
  ```ts
  type RingStatProps = {
    label: string;                 // e.g. "Steps"
    dotColor: string;              // metric hue
    state?: "value" | "empty" | "connect";  // default "value"
    value?: string;                // required when state === "value"
    meta?: string;                 // small line under value (e.g. "of 10,000")
    ringValue?: number;            // GaugeRing value (state "value" only)
    ringMax?: number;              // GaugeRing max
    ringGradient?: [string, string];
    onConnect?: () => void;        // tapped in "connect" state
    emptyText?: string;            // shown in "empty" state (default "—")
  };
  ```
  `state: "connect"` renders a tappable "Connect Apple Health" affordance (`accessibilityRole="button"`, `accessibilityLabel="Connect Apple Health"`) and **no number**. `state: "empty"` renders `emptyText` (default `—`). `state: "value"` renders the value + meta + a right-aligned mini `GaugeRing`.

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/RingStat.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { RingStat } from "../RingStat";

describe("RingStat", () => {
  it("value state shows the number + meta", async () => {
    const { getByText } = await render(
      <RingStat label="Steps" dotColor="#8FD400" state="value" value="8,240" meta="of 10,000" ringValue={8240} ringMax={10000} />,
    );
    expect(getByText("Steps")).toBeTruthy();
    expect(getByText("8,240")).toBeTruthy();
    expect(getByText("of 10,000")).toBeTruthy();
  });

  it("connect state shows the affordance and NO number", async () => {
    const onConnect = jest.fn();
    const { getByLabelText, queryByText } = await render(
      <RingStat label="Steps" dotColor="#8FD400" state="connect" value="8,240" onConnect={onConnect} />,
    );
    const btn = getByLabelText("Connect Apple Health");
    fireEvent.press(btn);
    expect(onConnect).toHaveBeenCalled();
    // INVARIANT: the passed value must never render in connect state
    expect(queryByText("8,240")).toBeNull();
  });

  it("empty state shows the placeholder, not a fabricated value", async () => {
    const { getByText, queryByText } = await render(
      <RingStat label="Avg intake" dotColor="#34C759" state="empty" value="1,921" />,
    );
    expect(getByText("—")).toBeTruthy();
    expect(queryByText("1,921")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/RingStat.test.tsx`
Expected: FAIL — `Cannot find module '../RingStat'`.

- [ ] **Step 3: Write `src/components/RingStat.tsx`**:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { GaugeRing } from "./GaugeRing";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type RingStatProps = {
  label: string;
  dotColor: string;
  state?: "value" | "empty" | "connect";
  value?: string;
  meta?: string;
  ringValue?: number;
  ringMax?: number;
  ringGradient?: [string, string];
  onConnect?: () => void;
  emptyText?: string;
};

function Header({ label, dotColor }: { label: string; dotColor: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: dotColor }} />
      <AppText variant="footnote" muted style={{ fontWeight: "600" }}>{label}</AppText>
    </View>
  );
}

// Metric tile with an explicit state machine. INVARIANT: "connect"/"empty"
// never render a number — only "value" does.
export function RingStat({ label, dotColor, state = "value", value, meta, ringValue = 0, ringMax = 0, ringGradient, onConnect, emptyText = "—" }: RingStatProps) {
  const { colors } = useTheme();

  if (state === "connect") {
    return (
      <View style={{ gap: 8 }}>
        <Header label={label} dotColor={dotColor} />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Connect Apple Health"
          haptic="selection"
          onPress={onConnect}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon name="heart" size={15} color={colors.accent} />
          <AppText variant="footnote" style={{ color: colors.accent, fontWeight: "600" }}>Connect Apple Health</AppText>
        </PressableScale>
      </View>
    );
  }

  if (state === "empty") {
    return (
      <View style={{ gap: 8 }}>
        <Header label={label} dotColor={dotColor} />
        <Numeral size={28}>{emptyText}</Numeral>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <View style={{ gap: 4, flexShrink: 1 }}>
        <Header label={label} dotColor={dotColor} />
        <Numeral size={28}>{value ?? emptyText}</Numeral>
        {meta ? <AppText variant="caption" muted>{meta}</AppText> : null}
      </View>
      <GaugeRing value={ringValue} max={ringMax} size={44} stroke={5} gradient={ringGradient} color={ringGradient ? undefined : dotColor} />
    </View>
  );
}
```

> If `Icon` has no `heart` glyph in its kebab→SF/lucide map, use an existing health-adjacent glyph already in the map (e.g. `activity`); verify against `src/components/Icon.tsx` before committing and pick one that exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/RingStat.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/RingStat.tsx src/components/__tests__/RingStat.test.tsx
git commit -m "feat(ui): RingStat tile — value/empty/connect-Health states"
```

---

### Task 5: `Sparkline` — small trend polyline

**Files:**
- Create: `src/components/Sparkline.tsx`
- Test: `src/components/__tests__/Sparkline.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`, `react-native-svg`.
- Produces: `Sparkline({ points, color?, width?, height? }: { points: number[]; color?: string; width?: number; height?: number })`. Renders an SVG polyline (`testID="sparkline"`) when `points.length >= 2`; returns `null` when fewer than 2 points (caller shows an empty state). No animation (small, static — safe).

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/Sparkline.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { Sparkline } from "../Sparkline";

describe("Sparkline", () => {
  it("renders a polyline for >=2 points", async () => {
    const { getByTestId } = await render(<Sparkline points={[1, 3, 2, 4]} />);
    const line = getByTestId("sparkline");
    expect(typeof line.props.points).toBe("string");
    expect(line.props.points.split(" ")).toHaveLength(4);
  });
  it("renders nothing for <2 points", async () => {
    const { queryByTestId } = await render(<Sparkline points={[5]} />);
    expect(queryByTestId("sparkline")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/Sparkline.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/components/Sparkline.tsx`**:

```tsx
import Svg, { Polyline } from "react-native-svg";
import { useTheme } from "@/theme";

type Props = { points: number[]; color?: string; width?: number; height?: number };

// Tiny static trend line for tiles (e.g. 7-day avg intake). Caller guards the
// "not enough data" case visually; we simply render nothing below 2 points.
export function Sparkline({ points, color, width = 72, height = 28 }: Props) {
  const { colors } = useTheme();
  if (points.length < 2) return null;
  const pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <Svg width={width} height={height}>
      <Polyline testID="sparkline" points={line} fill="none" stroke={color ?? colors.accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/Sparkline.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sparkline.tsx src/components/__tests__/Sparkline.test.tsx
git commit -m "feat(ui): Sparkline — small trend polyline primitive"
```

---

### Task 6: `StreakBars` — filled bar row for streak count

**Files:**
- Create: `src/components/StreakBars.tsx`
- Test: `src/components/__tests__/StreakBars.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`.
- Produces: `StreakBars({ count, window?, color? }: { count: number; window?: number; color?: string })`. Renders `window` (default 7) vertical bars; the last `min(count, window)` are filled with `color` (default `colors.accent`), the rest faint. Each bar is a plain `View` (no animation). Filled bars carry `testID="streak-bar-filled"`.

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/StreakBars.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { StreakBars } from "../StreakBars";

describe("StreakBars", () => {
  it("fills min(count, window) bars", async () => {
    const { getAllByTestId } = await render(<StreakBars count={3} window={7} />);
    expect(getAllByTestId("streak-bar-filled")).toHaveLength(3);
  });
  it("caps fill at the window", async () => {
    const { getAllByTestId } = await render(<StreakBars count={12} window={7} />);
    expect(getAllByTestId("streak-bar-filled")).toHaveLength(7);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/StreakBars.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/components/StreakBars.tsx`**:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";

type Props = { count: number; window?: number; color?: string };

// Row of small bars; the trailing `count` bars are filled to visualize a
// logging streak. Static (no animation) — safe on device.
export function StreakBars({ count, window = 7, color }: Props) {
  const { colors, radius } = useTheme();
  const filled = Math.min(Math.max(0, count), window);
  const barColor = color ?? colors.accent;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 4, height: 28 }}>
      {Array.from({ length: window }, (_, i) => {
        const isFilled = i >= window - filled;
        return (
          <View
            key={i}
            testID={isFilled ? "streak-bar-filled" : undefined}
            style={{
              flex: 1,
              height: isFilled ? 28 : 12,
              borderRadius: radius.sm,
              backgroundColor: isFilled ? barColor : colors.muted,
            }}
          />
        );
      })}
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/StreakBars.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreakBars.tsx src/components/__tests__/StreakBars.test.tsx
git commit -m "feat(ui): StreakBars — filled streak-count bars"
```

---

### Task 7: Elevated `Card` — depth variants (backward compatible)

**Files:**
- Modify: `src/components/Card.tsx`
- Test: `src/components/__tests__/primitives.test.tsx` (extend — Card is exercised here already; if not, add a focused Card block)

**Interfaces:**
- Consumes: `useTheme()` (`colors`, `radius`, `spacing`, `shadows`, `gradients`).
- Produces: `Card({ variant?, style, ...rest }: ViewProps & { variant?: "flat" | "elevated" | "hero" })`. `variant` defaults to `"flat"` — **identical to today's output** (background `card`, radius `lg`, padding `md`, no shadow) so every existing consumer is unchanged. `"elevated"` uses `colors.elevated`, `radius.xl`, `shadows.card`. `"hero"` = elevated **plus** a subtle SVG top-gradient tint overlay (green, low opacity) behind children. Overlay must not intercept touches (`pointerEvents="none"`) and must clip to the radius.

- [ ] **Step 1: Write the failing test** — append to `src/components/__tests__/primitives.test.tsx`:

```tsx
import { Card } from "@/components/Card";
import { Text } from "react-native";

describe("Card variants", () => {
  it("defaults to flat (no shadow) and renders children", async () => {
    const { getByText } = await render(<Card><Text>hi</Text></Card>);
    expect(getByText("hi")).toBeTruthy();
  });
  it("elevated variant applies a shadow", async () => {
    const { getByTestId } = await render(<Card variant="elevated" testID="c"><Text>x</Text></Card>);
    const flat = getByTestId("c");
    const style = Array.isArray(flat.props.style) ? Object.assign({}, ...flat.props.style) : flat.props.style;
    expect(style.shadowRadius).toBeGreaterThan(0);
  });
});
```

(If `primitives.test.tsx` lacks a top-level `render` import, add `import { render } from "@testing-library/react-native";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/primitives.test.tsx`
Expected: FAIL — `variant` unsupported; elevated has no shadow.

- [ ] **Step 3: Rewrite `src/components/Card.tsx`**:

```tsx
import { View, type ViewProps } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "@/theme";

type CardProps = ViewProps & { variant?: "flat" | "elevated" | "hero" };

// Flat = the original borderless surface (unchanged default). Elevated adds a
// real soft shadow + layered surface. Hero adds a faint green top-gradient tint.
export function Card({ variant = "flat", style, children, ...rest }: CardProps) {
  const { colors, radius, spacing, shadows, gradients } = useTheme();
  const elevated = variant !== "flat";
  const borderRadius = elevated ? radius.xl : radius.lg;

  return (
    <View
      style={[
        {
          backgroundColor: elevated ? colors.elevated : colors.card,
          borderRadius,
          padding: spacing.md,
          overflow: "hidden",
          ...(elevated ? shadows.card : null),
        },
        style,
      ]}
      {...rest}
    >
      {variant === "hero" ? (
        <Svg pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 96 }} width="100%" height={96} preserveAspectRatio="none" viewBox="0 0 100 96">
          <Defs>
            <LinearGradient id="cardHero" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0%" stopColor={gradients.green[0]} stopOpacity={0.12} />
              <Stop offset="100%" stopColor={gradients.green[0]} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={100} height={96} fill="url(#cardHero)" />
        </Svg>
      ) : null}
      {children}
    </View>
  );
}
```

> `overflow: "hidden"` is added even for flat — verify no existing screen relies on Card children overflowing its bounds (grep for shadows applied to Card itself in screens; none expected). If a shadow-on-Card consumer exists, gate `overflow: "hidden"` to `elevated` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS (full suite — Card is widely used; confirm no regressions), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/Card.tsx src/components/__tests__/primitives.test.tsx
git commit -m "feat(ui): Card depth variants — flat (default)/elevated/hero"
```

---

### Task 8: Display rows — `MealRow`, `LeaderRow`, `NotifRow`

**Files:**
- Create: `src/components/MealRow.tsx`, `src/components/LeaderRow.tsx`, `src/components/NotifRow.tsx`
- Test: `src/components/__tests__/rows.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`, `AppText`, `Numeral`, `Icon`, `Avatar`, `PressableScale`, `foodVisual` (existing, `src/lib/foodVisual.ts` — maps a food name to an icon; verify its exported function name before use).
- Produces:
  - `MealRow({ name, slot, kcal, iconName?, tint?, onPress?, accessibilityLabel? })` — colored glyph chip + name/slot + kcal. `testID="meal-row"`.
  - `LeaderRow({ rank, name, sub?, metric, isYou?, onPress? })` — rank numeral + gradient avatar + name/sub + colored metric; `isYou` green-highlights the row. `testID="leader-row"`.
  - `NotifRow({ type, iconName, tint, text, time, unread, onPress? })` — colored per-type icon chip + text + relative time + unread dot. `testID="notif-row"`.

These are presentational only; screens keep owning data + handlers.

- [ ] **Step 1: Write the failing test** — `src/components/__tests__/rows.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { MealRow } from "../MealRow";
import { LeaderRow } from "../LeaderRow";
import { NotifRow } from "../NotifRow";

describe("display rows", () => {
  it("MealRow shows name, slot, kcal and fires onPress", async () => {
    const onPress = jest.fn();
    const { getByText, getByTestId } = await render(
      <MealRow name="Oats" slot="breakfast" kcal={320} onPress={onPress} />,
    );
    expect(getByText("Oats")).toBeTruthy();
    expect(getByText(/320/)).toBeTruthy();
    fireEvent.press(getByTestId("meal-row"));
    expect(onPress).toHaveBeenCalled();
  });

  it("LeaderRow highlights the current user", async () => {
    const { getByText } = await render(
      <LeaderRow rank={1} name="You" metric="5 days" isYou />,
    );
    expect(getByText("You")).toBeTruthy();
    expect(getByText("5 days")).toBeTruthy();
  });

  it("NotifRow renders text, time and an unread dot", async () => {
    const { getByText, getByTestId } = await render(
      <NotifRow type="friend_request" iconName="user-plus" tint="#34C759" text="Ada added you" time="2h" unread />,
    );
    expect(getByText("Ada added you")).toBeTruthy();
    expect(getByText("2h")).toBeTruthy();
    expect(getByTestId("notif-unread-dot")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/components/__tests__/rows.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the three components.**

`src/components/MealRow.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { name: string; slot: string; kcal: number; iconName?: string; tint?: string; onPress?: () => void; accessibilityLabel?: string };

export function MealRow({ name, slot, kcal, iconName = "utensils", tint, onPress, accessibilityLabel }: Props) {
  const { colors, radius } = useTheme();
  const chip = tint ?? colors.accent;
  return (
    <PressableScale testID="meal-row" accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? name} haptic="selection" onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(chip, 0.16) }}>
        <Icon name={iconName} size={18} color={chip} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="headline">{name}</AppText>
        <AppText variant="footnote" muted>{slot}</AppText>
      </View>
      <Numeral size={17}>{`${Math.round(kcal)} kcal`}</Numeral>
    </PressableScale>
  );
}
```

`src/components/LeaderRow.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Avatar } from "./Avatar";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { rank: number; name: string; sub?: string; metric: string; isYou?: boolean; onPress?: () => void };

export function LeaderRow({ rank, name, sub, metric, isYou = false, onPress }: Props) {
  const { colors, radius, spacing } = useTheme();
  const initials = name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <PressableScale testID="leader-row" accessibilityRole={onPress ? "button" : undefined} haptic={onPress ? "selection" : "none"} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: isYou ? withAlpha(colors.accent, 0.12) : "transparent" }}>
      <Numeral size={15} color={colors.mutedForeground}>{String(rank)}</Numeral>
      <Avatar initials={initials} />
      <View style={{ flex: 1 }}>
        <AppText variant="headline" style={isYou ? { color: colors.accent } : undefined}>{name}</AppText>
        {sub ? <AppText variant="footnote" muted>{sub}</AppText> : null}
      </View>
      <AppText variant="headline" style={{ color: isYou ? colors.accent : colors.label }}>{metric}</AppText>
    </PressableScale>
  );
}
```

`src/components/NotifRow.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { type: string; iconName: string; tint: string; text: string; time: string; unread: boolean; onPress?: () => void };

export function NotifRow({ iconName, tint, text, time, unread, onPress }: Props) {
  const { colors, radius } = useTheme();
  return (
    <PressableScale testID="notif-row" accessibilityRole="button" haptic="selection" onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(tint, 0.16) }}>
        <Icon name={iconName} size={18} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="subheadline">{text}</AppText>
        <AppText variant="caption" muted>{time}</AppText>
      </View>
      {unread ? <View testID="notif-unread-dot" style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accent }} /> : null}
    </PressableScale>
  );
}
```

> Verify `withAlpha` is exported from `src/lib/color.ts` (the spec says it exists) and that the `Icon` glyph names used (`utensils`, `user-plus`) resolve in `src/components/Icon.tsx`; substitute existing glyphs if not. `Avatar`'s prop name (`initials`) is taken from `app/(tabs)/index.tsx` usage — confirm.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/components/__tests__/rows.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/MealRow.tsx src/components/LeaderRow.tsx src/components/NotifRow.tsx src/components/__tests__/rows.test.tsx
git commit -m "feat(ui): MealRow/LeaderRow/NotifRow display rows"
```

---

## Phase 2 — Core dashboards

> **These are restyle tasks.** The deliverable is edits to existing screens that swap in the elevated primitives while preserving every payload, testID, and verbatim a11y label. The **existing screen tests must pass unmodified** — treat any needed test edit as a signal you changed behavior, and stop. Add new assertions only for genuinely new UI (e.g. a new connect-state element). Per task: run the screen's test file, then the full suite + tsc.

### Task 9: Home restyle — hero GaugeRing + MacroBars v2 + Steps element + elevated hero card

**Files:**
- Modify: `src/components/home/KcalHero.tsx` (swap `CircularProgress` → `GaugeRing` with green gradient)
- Modify: `app/(tabs)/index.tsx` (elevated hero `Card`, add a Steps `RingStat` in **connect** state below the hero, `MealRow` for logged meals is optional — the existing `Row`/`GroupedSection` may stay; prefer keeping meal list behavior identical)
- Test: `app/(tabs)/__tests__/index.test.tsx` must pass **unmodified**; add a new test asserting the Steps connect-state element renders.

**Interfaces:**
- Consumes: `GaugeRing` (Task 2), `MacroBars` v2 (Task 3), `RingStat` (Task 4), `Card` variant `hero`/`elevated` (Task 7).
- Produces: no new exports. Steps element is a `RingStat` fixed to `state="connect"` for now (real wiring in Task 20). `onConnect` is a no-op placeholder here (`() => {}`) — **it must never show a number**.

- [ ] **Step 1: Migrate `KcalHero` to `GaugeRing`.** In `src/components/home/KcalHero.tsx` replace the `CircularProgress` import + usage:

```tsx
import { GaugeRing } from "@/components/GaugeRing";
// ...
const { colors, fonts, gradients } = useTheme();
// ...
<GaugeRing value={eaten} max={goal} size={72} stroke={8} gradient={gradients.green} />
```

Keep the `loading` "—" placeholder and `AnimatedNumber` usage exactly as-is.

- [ ] **Step 2: Run the Home test to confirm no behavior change**

Run: `npm test -- --ci "app/(tabs)/__tests__/index.test.tsx"`
Expected: PASS unmodified (the ring is presentational; kcal number + copy unchanged).

- [ ] **Step 3: Elevate the hero card + add Steps RingStat** in `app/(tabs)/index.tsx`. Change the hero `<Card>` to `<Card variant="hero">`. Directly below the hero card block (still gated on `!loadError`), add:

```tsx
<Animated.View entering={enter(2)} style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
  <Card variant="elevated">
    <RingStat label="Steps" dotColor={colors.stepsMetric} state="connect" onConnect={() => {}} />
  </Card>
</Animated.View>
```

Import `RingStat`. Bump the subsequent meal-section `enter(2)` to `enter(3)` so the stagger index stays monotonic.

- [ ] **Step 4: Add a new test for the Steps connect element** — append to `app/(tabs)/__tests__/index.test.tsx` (do **not** modify existing tests):

```tsx
it("shows a Connect Apple Health affordance for Steps (never a number yet)", async () => {
  // render with a successful dashboard (reuse the file's existing render helper/mocks)
  const { getByLabelText } = renderHome(); // use whatever the file already uses to render
  expect(getByLabelText("Connect Apple Health")).toBeTruthy();
});
```

Adapt `renderHome()` to the file's existing render pattern.

- [ ] **Step 5: Run full gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add "src/components/home/KcalHero.tsx" "app/(tabs)/index.tsx" "app/(tabs)/__tests__/index.test.tsx"
git commit -m "feat(ui): Home — gradient GaugeRing hero, MacroBars v2, Steps connect tile"
```

---

### Task 10: Progress restyle — 2×2 grid, **remove fabricated numbers**

**Files:**
- Modify: `app/(tabs)/progress.tsx`
- Test: `app/(tabs)/__tests__/progress.test.tsx` — update the assertions that referenced the **fabricated** strings (this is the one place a test edit is correct: those strings were the bug). Add assertions that the fake values are gone and connect/streak states render.

**Interfaces:**
- Consumes: `RingStat` (connect state for Steps + Sleep), `Sparkline` (Task 5), `StreakBars` (Task 6), `Card variant="elevated"`, existing `WeightChart`/`Segmented`.
- Produces: the 2×2 grid becomes: **Avg intake** → `state="empty"` (`—`) for now (real 7-day in Task 20); **Log streak** → real `streak` + `StreakBars`; **Steps** → `state="connect"`; **Sleep** → `state="connect"`. **No hardcoded `"1,921"`/`"8,240"`/`"7.1"` may remain.**

- [ ] **Step 1: Delete the fabricated grid** in `app/(tabs)/progress.tsx`. Replace the four `<Card>...<Stat .../></Card>` cells (the block containing `"1,921"`, `"8,240"`, `"7.1"`) with:

```tsx
<Animated.View entering={enter(2)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
  <Card variant="elevated" style={{ flexGrow: 1, flexBasis: "45%", gap: 8 }}>
    <RingStat label="Avg intake" dotColor={colors.accent} state="empty" />
    <Sparkline points={[]} color={colors.accent} />
  </Card>
  <Card variant="elevated" style={{ flexGrow: 1, flexBasis: "45%", gap: 8 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <RingStat label="Log streak" dotColor={colors.accent} state="value" value={String(streak)} meta={streak === 1 ? "day" : "days"} />
    </View>
    <StreakBars count={streak} />
  </Card>
  <Card variant="elevated" style={{ flexGrow: 1, flexBasis: "45%" }}>
    <RingStat label="Steps" dotColor={colors.stepsMetric} state="connect" onConnect={() => {}} />
  </Card>
  <Card variant="elevated" style={{ flexGrow: 1, flexBasis: "45%" }}>
    <RingStat label="Sleep" dotColor={colors.sleepMetric} state="connect" onConnect={() => {}} />
  </Card>
</Animated.View>
```

Import `RingStat`, `Sparkline`, `StreakBars`, and `View` (if not already). Remove the now-unused `Stat` import if nothing else uses it. Make the weight `<Card>` `variant="elevated"`.

- [ ] **Step 2: Update the Progress test** — in `app/(tabs)/__tests__/progress.test.tsx`, remove any assertion on `"1,921"`, `"8,240"`, or `"7.1"` and add:

```tsx
it("never renders the old fabricated metrics", async () => {
  const { queryByText } = renderProgress(); // file's existing render helper
  expect(queryByText("1,921")).toBeNull();
  expect(queryByText("8,240")).toBeNull();
  expect(queryByText("7.1")).toBeNull();
});
it("offers Connect Apple Health for Steps and Sleep", async () => {
  const { getAllByLabelText } = renderProgress();
  expect(getAllByLabelText("Connect Apple Health").length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 3: Run full gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add "app/(tabs)/progress.tsx" "app/(tabs)/__tests__/progress.test.tsx"
git commit -m "feat(ui): Progress — remove fabricated metrics; RingStat/StreakBars grid"
```

---

### Task 11: Diary restyle — gradient week pill, day-summary GaugeRing, MealRow cards

**Files:**
- Modify: `app/(tabs)/diary.tsx`
- Test: `app/(tabs)/__tests__/diary.test.tsx`, `app/__tests__/diary-water.test.tsx`, `app/__tests__/diary-copy.test.tsx` — **all pass unmodified** (water payload `${selected}T12:00:00Z`, swipe-delete confirm copy + payload, openMeal params, week-strip a11y labels must be byte-identical).

**Interfaces:**
- Consumes: `GaugeRing` (day-summary ring), `MealRow` (Task 8) for the slot rows (replacing the plain `Row` inside `Swipeable`), `Card variant="elevated"` for the summary + meal groups.
- Produces: no new exports. The `WeekDayCell` selected fill may adopt a gradient pill (green gradient) but keeps its exact `accessibilityLabel={iso(date)}` + `accessibilityState={{ selected }}` and the loggable dot.

- [ ] **Step 1: Restyle the day-summary card** — wrap the `AnimatedStat` row in `Card variant="elevated"` and add a compact `GaugeRing` (eaten/goal) beside Total/Left/Water. Keep `AnimatedStat` (it animates via `AnimatedNumber` — worklet-safe) and the water `L` formatter unchanged.

- [ ] **Step 2: Swap the meal `Row` for `MealRow`** inside the `Swipeable` `renderRightActions` block — but **keep** the `Swipeable` + `PressableScale` delete action (a11y label `Delete ${log.description}`, `confirmDelete` payload) and the `openMeal(log)` push params **byte-identical**. `MealRow` gets `name={log.description}`, `slot={`${Math.round(log.quantity_grams)}g · ${timeOf(log.logged_at)}`}`, `kcal={log.kcal}`, `onPress={() => openMeal(log)}`, and a food-hued `tint`/`iconName` from `foodVisual(log.description)`.

- [ ] **Step 3: Gradient week pill (optional polish)** — in `WeekDayCell`, the selected circle may render an SVG green-gradient fill instead of solid `colors.accent`; the today-outline ring, the `AppText` day number color logic, and all a11y props stay identical.

- [ ] **Step 4: Run the invariant tests unmodified**

Run: `npm test -- --ci "app/(tabs)/__tests__/diary.test.tsx" "app/__tests__/diary-water.test.tsx" "app/__tests__/diary-copy.test.tsx"`
Expected: PASS with **no** edits to those files. If any fails, you changed behavior — revert and redo the restyle.

- [ ] **Step 5: Full gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add "app/(tabs)/diary.tsx"
git commit -m "feat(ui): Diary — elevated day summary, MealRow cards, gradient week pill"
```

---

### Task 12: Remove dead `CircularProgress`

**Files:**
- Delete: `src/components/CircularProgress.tsx`, `src/components/__tests__/CircularProgress.test.tsx`
- Modify: any lingering importers (should be none after Tasks 9 + 11)

- [ ] **Step 1: Confirm no live references**

Run: `grep -rn "CircularProgress" src app | grep -v "__tests__/CircularProgress"`
Expected: no output. If any hit, migrate it to `GaugeRing` first (same props except `gradient`).

- [ ] **Step 2: Delete the files**

```bash
git rm src/components/CircularProgress.tsx src/components/__tests__/CircularProgress.test.tsx
```

- [ ] **Step 3: Full gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS (suite count drops by the CircularProgress cases), tsc clean.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(ui): drop CircularProgress, superseded by GaugeRing"
```

---

## Phase 3 — Capture + social + rest

> Restyle tasks; same discipline as Phase 2. Every payload/consent/a11y test in these files passes **unmodified**. Before each, read the target screen and its test file to learn the exact render helper + preserved assertions.

### Task 13: Capture polish — SVG gradient bg, detected-food GaugeRing + macro chips

**Files:**
- Modify: `app/capture.tsx`, `src/components/capture/DetectedCard.tsx`, possibly `src/components/capture/captureTheme.ts` (raw hex allowed **here**)
- Test: `app/__tests__/capture.test.tsx`, `src/components/capture/__tests__/DetectedCard.test.tsx`, `src/lib/__tests__/resolutionKcal.test.ts` — pass **unmodified** (no-fabricated-nutrition: kcal shown verbatim from `Resolution`, payloads for `useResolveText/Photo/Voice` unchanged).

- [ ] **Step 1:** Read `app/capture.tsx` + `DetectedCard.tsx` + `captureTheme.ts` and their tests to inventory preserved payloads (`client_log_ms`, resolve file shape, `createLog` mapping) and testIDs.
- [ ] **Step 2:** Add a full-bleed SVG gradient background layer (dark) behind the composer; keep all bubbles/mode pills behavior. Detected-food card: add a `GaugeRing` (kcal vs a display max) + colored macro chips (green/steps/sleep tints) + keep the "Add all to diary" action and its exact mutation payloads.
- [ ] **Step 3:** Run invariant tests unmodified:

Run: `npm test -- --ci "app/__tests__/capture.test.tsx" "src/components/capture/__tests__/DetectedCard.test.tsx" "src/lib/__tests__/resolutionKcal.test.ts"`
Expected: PASS, no edits to those files.
- [ ] **Step 4:** Full gate + commit:

```bash
git add "app/capture.tsx" "src/components/capture/DetectedCard.tsx" "src/components/capture/captureTheme.ts"
git commit -m "feat(ui): Capture — gradient canvas, detected-food ring + macro chips"
```

---

### Task 14: Friends + Groups — LeaderRow leaderboards (consent-safe)

**Files:**
- Modify: `app/friends.tsx`, `app/groups.tsx`, `app/group/[id].tsx`, `src/components/social/FriendsLeaderboard.tsx`
- Test: `app/__tests__/friends.test.tsx`, `app/__tests__/groups.test.tsx`, `app/__tests__/group-detail.test.tsx`, `src/components/social/__tests__/FriendsLeaderboard.test.tsx` — pass **unmodified** (consent gate: non-sharers show name only / aggregate, never metrics; share-progress toggle payload; accept/decline/unfriend/invite payloads).

- [ ] **Step 1:** Read the four files + tests; note the consent branch (`sharing` flag → metric vs name-only) and every mutation payload.
- [ ] **Step 2:** Swap ranked lists to `LeaderRow` (rank + gradient avatar + colored metric + `isYou`). **Preserve the consent branch exactly** — a non-sharing friend still renders through `LeaderRow` with no metric (pass an empty/`"—"`-free aggregate label as today). The share-progress toggle and "Not sharing" group are unchanged.
- [ ] **Step 3:** Invariant tests unmodified:

Run: `npm test -- --ci "app/__tests__/friends.test.tsx" "app/__tests__/groups.test.tsx" "app/__tests__/group-detail.test.tsx" "src/components/social/__tests__/FriendsLeaderboard.test.tsx"`
Expected: PASS, no edits.
- [ ] **Step 4:** Full gate + commit:

```bash
git add "app/friends.tsx" "app/groups.tsx" "app/group/[id].tsx" "src/components/social/FriendsLeaderboard.tsx"
git commit -m "feat(ui): Friends/Groups — LeaderRow leaderboards, consent preserved"
```

---

### Task 15: Challenge + Notifications — standings + colored NotifRow

**Files:**
- Modify: `app/challenge/[id].tsx`, `app/notifications.tsx`
- Test: `app/__tests__/challenge-detail.test.tsx`, `app/__tests__/notifications.test.tsx` — pass **unmodified** (join/leave/delete payloads; deep-link targets via `notificationTarget`; mark-all-read).

- [ ] **Step 1:** Read both screens + tests; note the winner/standings shape and the notification `type → route` mapping (`src/lib/notificationTarget.ts`) + per-type icon/tint mapping (create a small local `type → {icon,tint}` map if none exists — tint from theme tokens).
- [ ] **Step 2:** Challenge standings → `LeaderRow` (winner banner keeps the trophy). Notifications → `NotifRow` (per-type colored icon chip, unread dot, relative time via existing `relativeTime`). Deep-links + mark-read unchanged.
- [ ] **Step 3:** Invariant tests unmodified:

Run: `npm test -- --ci "app/__tests__/challenge-detail.test.tsx" "app/__tests__/notifications.test.tsx"`
Expected: PASS, no edits.
- [ ] **Step 4:** Full gate + commit:

```bash
git add "app/challenge/[id].tsx" "app/notifications.tsx"
git commit -m "feat(ui): Challenge standings + colored NotifRow notifications"
```

---

### Task 16: Meal / Log / More / Sign-in / Onboarding — adopt elevated cards + type

**Files:**
- Modify: `app/meal.tsx`, `app/log.tsx`, `app/(tabs)/more.tsx`, `app/sign-in.tsx`, `app/onboarding.tsx`
- Test: `app/__tests__/meal.test.tsx`, `app/__tests__/log.test.tsx`, `app/(tabs)/__tests__/more.test.tsx`, `app/__tests__/sign-in.test.tsx`, `app/__tests__/onboarding.test.tsx`, `src/lib/__tests__/validateOnboarding.test.ts` — pass **unmodified** (meal PATCH via `useEditLog`, delete confirm; log `createLog` + `client_log_ms`; firebase sign-in; onboarding submit + `validateOnboardingNumbers` gate).

- [ ] **Step 1:** Read each screen + test; inventory preserved payloads/validation/firebase calls.
- [ ] **Step 2:** Apply `Card variant="elevated"`, elevated tiles, and the editorial type scale consistently. **No payload, validation, or firebase change.** Onboarding goal cards + TDEE fields keep their exact submit shape.
- [ ] **Step 3:** Invariant tests unmodified:

Run: `npm test -- --ci "app/__tests__/meal.test.tsx" "app/__tests__/log.test.tsx" "app/(tabs)/__tests__/more.test.tsx" "app/__tests__/sign-in.test.tsx" "app/__tests__/onboarding.test.tsx" "src/lib/__tests__/validateOnboarding.test.ts"`
Expected: PASS, no edits.
- [ ] **Step 4:** Full gate + commit:

```bash
git add "app/meal.tsx" "app/log.tsx" "app/(tabs)/more.tsx" "app/sign-in.tsx" "app/onboarding.tsx"
git commit -m "feat(ui): elevated cards + type across meal/log/more/sign-in/onboarding"
```

---

## Phase 4 — Apple Health + real data

### Task 17: Add HealthKit dependency, config plugin, Info.plist string, jest mock

**Files:**
- Modify: `package.json` (via `expo install`), `app.json`/`app.config.*` (plugin + usage description), `jest.setup.js` (mock)
- Test: `npm test -- --ci` (mock resolves; no test crash)

**Interfaces:**
- Produces: `@kingstinct/react-native-healthkit` installed + configured; a jest mock so `useHealth` (Task 18) can be tested off-device. **Requires a dev-client rebuild** — done in Task 21; code + mock land here.

- [ ] **Step 1: Install the library**

Run: `npx expo install @kingstinct/react-native-healthkit`
Verify it resolves for Expo SDK 57 + New Architecture. If the config plugin is incompatible (build/config error), STOP and escalate — the spec names `react-native-health` (older) or a thin custom module as fallbacks; the reviewer/controller decides.

- [ ] **Step 2: Register the config plugin + usage string** in `app.json` (or `app.config.ts`) `expo.plugins` — per the library's README (adds `NSHealthShareUsageDescription`). Usage string: `"Kora reads your steps and sleep to show real activity alongside your nutrition."`

- [ ] **Step 3: Add the jest mock** to `jest.setup.js` (append), mirroring the library's actual API surface used by `useHealth` (confirm exact export names against the installed package before finalizing):

```javascript
// @kingstinct/react-native-healthkit: native HealthKit is unavailable under Jest
// and on the simulator. Default mock reports "unavailable" so degraded-state tests
// pass; individual tests override per-case (authorized/denied) via jest.mock.
jest.mock("@kingstinct/react-native-healthkit", () => ({
  isHealthDataAvailable: jest.fn(async () => false),
  requestAuthorization: jest.fn(async () => false),
  queryQuantitySamples: jest.fn(async () => []),
  queryCategorySamples: jest.fn(async () => []),
}));
```

- [ ] **Step 4: Gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json app.json jest.setup.js
git commit -m "chore(health): add @kingstinct/react-native-healthkit + plugin + jest mock"
```

---

### Task 18: `useHealth()` hook + types — client-only, honest degradation

**Files:**
- Create: `src/health/types.ts`, `src/health/useHealth.ts`, `src/health/index.ts`
- Test: `src/health/__tests__/useHealth.test.tsx`

**Interfaces:**
- Consumes: `@kingstinct/react-native-healthkit` (mocked in tests), `react-native` `Platform`.
- Produces:
  ```ts
  // src/health/types.ts
  export type HealthStatus = "authorized" | "denied" | "unavailable";
  export type HealthData = {
    status: HealthStatus;
    steps: { today: number; goal: number } | null;
    sleep: { lastNightHours: number } | null;
    connect: () => void; // re-request auth / deep-link to Settings if denied
  };
  ```
  `useHealth(): HealthData`. On mount: if `Platform.OS !== "ios"` or `!isHealthDataAvailable()` → `unavailable`. Else request read auth for `stepCount` + `sleepAnalysis`; on grant → `authorized` and fetch today's steps (sum of device-local-day samples) + last-night asleep hours; on decline → `denied`. `steps`/`sleep` are `null` unless `authorized`. **Never returns a fabricated number.**

- [ ] **Step 1: Write the failing test** — `src/health/__tests__/useHealth.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react-native";

describe("useHealth", () => {
  afterEach(() => jest.resetModules());

  it("reports unavailable when HealthKit is not available (sim/Android)", async () => {
    jest.doMock("@kingstinct/react-native-healthkit", () => ({
      isHealthDataAvailable: jest.fn(async () => false),
      requestAuthorization: jest.fn(async () => false),
      queryQuantitySamples: jest.fn(async () => []),
      queryCategorySamples: jest.fn(async () => []),
    }));
    const { useHealth } = require("../useHealth");
    const { result } = renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.steps).toBeNull();
    expect(result.current.sleep).toBeNull();
  });

  it("reports denied when the user declines and exposes no numbers", async () => {
    jest.doMock("react-native/Libraries/Utilities/Platform", () => ({ OS: "ios", select: (o) => o.ios }));
    jest.doMock("@kingstinct/react-native-healthkit", () => ({
      isHealthDataAvailable: jest.fn(async () => true),
      requestAuthorization: jest.fn(async () => false),
      queryQuantitySamples: jest.fn(async () => []),
      queryCategorySamples: jest.fn(async () => []),
    }));
    const { useHealth } = require("../useHealth");
    const { result } = renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.steps).toBeNull();
  });

  it("reports authorized with summed steps when granted", async () => {
    jest.doMock("react-native/Libraries/Utilities/Platform", () => ({ OS: "ios", select: (o) => o.ios }));
    jest.doMock("@kingstinct/react-native-healthkit", () => ({
      isHealthDataAvailable: jest.fn(async () => true),
      requestAuthorization: jest.fn(async () => true),
      queryQuantitySamples: jest.fn(async () => [{ quantity: 3000 }, { quantity: 2200 }]),
      queryCategorySamples: jest.fn(async () => []),
    }));
    const { useHealth } = require("../useHealth");
    const { result } = renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("authorized"));
    expect(result.current.steps?.today).toBe(5200);
  });
});
```

> The exact HealthKit query function names/return shapes depend on the installed package version — **read the package's TypeScript types before writing Step 3** and adjust both the mock and the reducer (`quantity` field name, sample shape) to match. Keep the three states + the summation contract; adapt the mechanics.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/health/__tests__/useHealth.test.tsx`
Expected: FAIL — `Cannot find module '../useHealth'`.

- [ ] **Step 3: Write `src/health/types.ts`, `src/health/useHealth.ts`, `src/health/index.ts`.**

`src/health/types.ts` — exactly the `HealthStatus`/`HealthData` above.

`src/health/useHealth.ts` (adapt query calls to the installed API):

```tsx
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import * as HK from "@kingstinct/react-native-healthkit";
import type { HealthData, HealthStatus } from "./types";

const STEP_GOAL = 10000;

function startOfLocalDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function useHealth(): HealthData {
  const [status, setStatus] = useState<HealthStatus>("unavailable");
  const [steps, setSteps] = useState<HealthData["steps"]>(null);
  const [sleep, setSleep] = useState<HealthData["sleep"]>(null);

  const load = useCallback(async () => {
    if (Platform.OS !== "ios" || !(await HK.isHealthDataAvailable())) {
      setStatus("unavailable");
      setSteps(null);
      setSleep(null);
      return;
    }
    const granted = await HK.requestAuthorization(["HKQuantityTypeIdentifierStepCount", "HKCategoryTypeIdentifierSleepAnalysis"]);
    if (!granted) {
      setStatus("denied");
      setSteps(null);
      setSleep(null);
      return;
    }
    setStatus("authorized");
    const from = startOfLocalDay();
    const stepSamples = await HK.queryQuantitySamples("HKQuantityTypeIdentifierStepCount", { from });
    const total = stepSamples.reduce((s: number, x: any) => s + (x.quantity ?? 0), 0);
    setSteps({ today: Math.round(total), goal: STEP_GOAL });
    // sleep window = last night → this morning; sum "asleep" category samples
    const sleepSamples = await HK.queryCategorySamples("HKCategoryTypeIdentifierSleepAnalysis", { from: new Date(from.getTime() - 16 * 3600 * 1000) });
    const asleepMs = sleepSamples.reduce((s: number, x: any) => s + asleepDurationMs(x), 0);
    setSleep({ lastNightHours: Math.round((asleepMs / 3600000) * 10) / 10 });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(() => {
    if (status === "denied") {
      void Linking.openURL("x-apple-health://");
      return;
    }
    void load();
  }, [status, load]);

  return { status, steps, sleep, connect };
}

// Adjust to the installed package's sleep sample shape (value/enum + start/end).
function asleepDurationMs(sample: any): number {
  const asleepValues = new Set([1, 3, 4, 5]); // ASLEEP*/INBED per HealthKit enum — verify against package
  if (sample.value != null && !asleepValues.has(sample.value)) return 0;
  const start = new Date(sample.startDate).getTime();
  const end = new Date(sample.endDate).getTime();
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
```

`src/health/index.ts`:

```tsx
export * from "./types";
export * from "./useHealth";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/health/__tests__/useHealth.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/health/ 
git commit -m "feat(health): useHealth hook — client-only steps/sleep, honest degradation"
```

---

### Task 19: `useAvgIntake7d()` — real 7-day average, client-side

**Files:**
- Modify: `src/api/hooks.ts` (add the hook — read-only, reuses `/v1/dashboard`)
- Test: `src/api/__tests__/hooks.test.tsx` (extend)

**Interfaces:**
- Consumes: `useQueries` (@tanstack/react-query), existing `apiFetch`, `DashboardSummary`.
- Produces: `useAvgIntake7d(endDate: string): { avg: number | null; series: number[]; isLoading: boolean }`. Fans out `useQueries` over the 7 local days ending at `endDate` (inclusive), reads each `consumed.kcal`, returns `series` (chronological, only days that have data) and `avg = round(mean(series))` — or `avg: null` when `series.length < 1`. **No new endpoint; no fabricated fallback.**

- [ ] **Step 1: Write the failing test** — append to `src/api/__tests__/hooks.test.tsx` (follow the file's existing `apiFetch` mock + `QueryClientProvider` wrapper pattern):

```tsx
import { useAvgIntake7d } from "@/api/hooks";

it("averages consumed kcal across the last 7 days that have data", async () => {
  // mock apiFetch so each /v1/dashboard?date= returns a known consumed.kcal
  // (reuse the file's mock; here e.g. return 2000 for every date)
  const { result } = renderHook(() => useAvgIntake7d("2026-07-27"), { wrapper });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.series.length).toBeGreaterThan(0);
  expect(result.current.avg).toBe(2000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --ci src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useAvgIntake7d` not exported.

- [ ] **Step 3: Add the hook** to `src/api/hooks.ts`:

```typescript
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
// ...

// Client-only 7-day average intake. Reuses the existing dashboard endpoint per
// day (React Query caches each date), averages only days that returned data —
// never fabricates a value; returns avg: null when there's no data at all.
export function useAvgIntake7d(endDate: string): { avg: number | null; series: number[]; isLoading: boolean } {
  const dates: string[] = [];
  const end = new Date(`${endDate}T00:00:00`);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(d.toLocaleDateString("en-CA"));
  }
  const results = useQueries({
    queries: dates.map((date) => ({
      queryKey: ["dashboard", date],
      queryFn: () => apiFetch(`/v1/dashboard?date=${date}`) as Promise<DashboardSummary>,
    })),
  });
  const isLoading = results.some((r) => r.isLoading);
  const series = results
    .map((r) => r.data?.consumed.kcal)
    .filter((k): k is number => typeof k === "number" && k > 0);
  const avg = series.length ? Math.round(series.reduce((s, k) => s + k, 0) / series.length) : null;
  return { avg, series, isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --ci src/api/__tests__/hooks.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/hooks.ts src/api/__tests__/hooks.test.tsx
git commit -m "feat(health): useAvgIntake7d — real client-side 7-day average intake"
```

---

### Task 20: Wire real data — Home Steps, Progress Steps/Sleep/Avg-intake

**Files:**
- Modify: `app/(tabs)/index.tsx`, `app/(tabs)/progress.tsx`
- Test: `app/(tabs)/__tests__/index.test.tsx`, `app/(tabs)/__tests__/progress.test.tsx` — extend; the default mocks keep Health `unavailable` (sim parity) so existing connect-state assertions still hold. Add an authorized-path test overriding the Health mock.

**Interfaces:**
- Consumes: `useHealth` (Task 18), `useAvgIntake7d` (Task 19).
- Produces: Steps/Sleep `RingStat`s now derive `state` from `useHealth().status` (`authorized` → `value` with the real number + ring; else `connect` with `onConnect={health.connect}`). Avg intake derives from `useAvgIntake7d(today)` → `value` when `avg != null`, else `empty`; Sparkline uses `series`. **Invariant:** in any non-authorized / no-data path, no number renders.

- [ ] **Step 1: Home** — in `app/(tabs)/index.tsx`, call `const health = useHealth();` and drive the Steps `RingStat`:

```tsx
<RingStat
  label="Steps"
  dotColor={colors.stepsMetric}
  state={health.status === "authorized" ? "value" : "connect"}
  value={health.steps ? health.steps.today.toLocaleString() : undefined}
  meta={health.steps ? `of ${health.steps.goal.toLocaleString()}` : undefined}
  ringValue={health.steps?.today ?? 0}
  ringMax={health.steps?.goal ?? 0}
  ringGradient={gradients.steps}
  onConnect={health.connect}
/>
```

Add `gradients` to the `useTheme()` destructure.

- [ ] **Step 2: Progress** — in `app/(tabs)/progress.tsx`, call `const health = useHealth();` and `const avg = useAvgIntake7d(today());`. Drive:
  - Avg intake: `state={avg.avg != null ? "value" : "empty"}`, `value={avg.avg?.toLocaleString()}`, meta `"7-day avg"`; `<Sparkline points={avg.series} color={colors.accent} />`.
  - Steps: `state={health.status === "authorized" ? "value" : "connect"}`, real `value`/`ring*`/`ringGradient={gradients.steps}`, `onConnect={health.connect}`.
  - Sleep: same pattern; `value={health.sleep ? `${health.sleep.lastNightHours}` : undefined}`, meta `"last night"`, `ringGradient={gradients.sleep}` (ring vs an 8h target: `ringMax={8}`, `ringValue={health.sleep?.lastNightHours ?? 0}`).

- [ ] **Step 3: Add authorized-path tests** (do not weaken the existing unavailable/connect assertions). Example for Progress:

```tsx
it("shows real steps when Health is authorized", async () => {
  jest.doMock("@/health", () => ({
    useHealth: () => ({ status: "authorized", steps: { today: 8240, goal: 10000 }, sleep: { lastNightHours: 7.1 }, connect: jest.fn() }),
  }));
  // re-require the screen after doMock, render, assert getByText("8,240") and "7.1"
});
```

(Use the file's established re-require-after-doMock pattern; if simpler, mock `@/health` at top with a mutable return.)

- [ ] **Step 4: Full gate**

Run: `npm test -- --ci && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add "app/(tabs)/index.tsx" "app/(tabs)/progress.tsx" "app/(tabs)/__tests__/index.test.tsx" "app/(tabs)/__tests__/progress.test.tsx"
git commit -m "feat(health): wire real steps/sleep + 7-day avg intake into Home + Progress"
```

---

## Phase 5 — Live fidelity pass

### Task 21: Dev-client rebuild + sim + device verification (controller-driven)

**This task is not a subagent TDD task** — it is a controller-driven live pass, like the prior redesign's Phase 4. No new unit tests; it verifies real rendering and catches the device-only bug class.

**Environment (from handoff):** Docker holds 8081 → run Metro on **8091** (`RCT_METRO_PORT=8091 npx expo start --dev-client --port 8091`). Sim: iPhone 17 Pro (`AD109A46-2F99-43C3-8AAA-FEE68DC8499E`), iOS 26.2. Drive with `idb` (tap = displayed_px × 1.31 ÷ 3). Screenshots via `xcrun simctl io <udid> screenshot`. Dark toggle `xcrun simctl ui <udid> appearance dark|light`. Backend `/ready` on 8080; demo user authenticated.

- [ ] **Step 1: Rebuild the dev client** for the HealthKit native module:

Run: `npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E`
Expected: pod install picks up `@kingstinct/react-native-healthkit`; app boots.

- [ ] **Step 2: Simulator visual pass** — Home / Progress / Diary / Capture / Friends / Groups / Challenge / Notifications / Meal / Log / More / Sign-in / Onboarding, in **light and dark** and with **reduced motion** on. Confirm: filled gradient rings, colored RingStat tiles, gradient MacroBars, Sparkline, StreakBars, elevated cards with real shadow, LeaderRow/NotifRow — all match the approved mockup (`scratchpad/kora-elevated.html`, artifact `5ada2418-...`).

- [ ] **Step 3: Degraded-Health invariant on the sim** — Steps/Sleep on Home + Progress MUST show "Connect Apple Health", **never a number** (the sim has no Health data). Avg intake shows a real value or `—` — never a fabricated number.

- [ ] **Step 4: Device pass (real Health)** — on a physical iPhone: grant Health, confirm real today-steps + last-night-sleep render; decline → "Connect Apple Health" (never a number). Device-verify **every** animated component (GaugeRing sweep, MacroBars width, AnimatedNumber, WeightChart draw-in) for the worklet-runtime crash class.

- [ ] **Step 5: Fix findings** via a consolidated fix subagent (or inline for trivial), re-verify live, ledger each fix.

- [ ] **Step 6: Commit any fixes** with single-line messages, then this phase is complete.

---

## Self-Review (author checklist — completed)

**Spec coverage:**
- Visual system tokens (metric hues, gradients, elevation) → Task 1. ✓
- GaugeRing → T2; MacroBars v2 → T3; RingStat (3 states) → T4; Sparkline → T5; StreakBars → T6; elevated Card → T7; MealRow/LeaderRow/NotifRow → T8. ✓
- AreaTrend: the existing `WeightChart` already implements gradient area + line + endpoint dot + draw-in (the spec's AreaTrend); it is reused as-is and only wrapped in an elevated Card (T10) — no separate rebuild task needed. ✓ (documented, not a gap)
- Home / Progress / Diary restyle → T9 / T10 / T11. ✓
- Capture / Friends / Groups / Challenge / Notifications / Meal / Log / More / Sign-in / Onboarding → T13–T16. ✓
- Apple Health lib + plugin + rebuild + `useHealth` + degraded states → T17, T18, T21. ✓
- Real 7-day avg intake → T19, wired T20. ✓
- Steps on Home → T9 (connect placeholder) + T20 (real). ✓
- Remove fabricated Progress numbers → T10. ✓
- Live pass (sim degraded + device real) → T21. ✓

**Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — code shown in every code step; restyle tasks name exact files, preserved payloads, and the unmodified proof-test commands. Restyle tasks intentionally show targeted snippets rather than full screen rewrites (the implementer reads the file), with explicit preserved-invariant lists + verification commands.

**Type consistency:** `GaugeRing` props (`gradient?: [string,string]`, `color?`) consistent across T2/T4/T9/T10/T20. `RingStat` `state` union `"value"|"empty"|"connect"` consistent T4→T20. `HealthData` shape (`status`/`steps`/`sleep`/`connect`) consistent T18→T20. `useAvgIntake7d` return (`avg`/`series`/`isLoading`) consistent T19→T20. `Macros` interface unchanged T3. `Card` `variant` union consistent T7→uses.

**Open verification items flagged for implementers (not gaps — confirm against code before writing):** exact `@kingstinct/react-native-healthkit` API names + sleep enum (T18); `withAlpha` export + `Icon` glyph names + `Avatar` prop (T8); `foodVisual` export name (T11); each restyle file's render-helper/mocks (T9–T16, T20).
