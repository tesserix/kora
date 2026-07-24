# Phase 1c — Kora UI Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every primary Kora screen (Home, Diary, Progress, Onboarding, Log/Meal-detail) match its high-fidelity mockup in `design-system/ui_kits/kora/` — a real circular ring, FoodTiles, a floating tab bar, editorial headline + capture hero, `ScreenHeader`/`Sheet` — replacing the dependency-free MVP widgets shipped in Phase 1a.

**Architecture:** Add shared RN infra first (SVG ring, Lucide icon wrapper, FoodTile, ScreenHeader/Avatar/Stat/Badge, Sheet, floating TabBar, editorial type + hue helpers). Then convert the app from a flat `Stack` to an Expo Router `(tabs)` group with a custom glassy floating tab bar, moving the auth/onboarding guard into the tabs layout. Then rebuild each screen straight from its mockup. AI-dependent bits (Otto copy, camera/voice/AI capture, weight tracking) ship as tasteful static placeholders that still match the mockup's shape.

**Tech Stack:** Expo SDK 57 / React Native 0.86 / Expo Router 57, TypeScript, `react-native-svg` (ring + weight chart), `lucide-react-native` (icons — exact parity with mockups), `expo-blur` (glassy tab bar), TanStack Query v5 (existing), jest-expo + RNTL v14 (tests).

## Global Constraints

- **Stack is fixed:** Expo SDK 57, RN 0.86, React 19.2, Expo Router 57. Install every native/Expo dep with `npx expo install <pkg>` (never bare `npm install`) so the SDK-57-compatible version is chosen. Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before using any new Expo/native API (`apps/mobile/AGENTS.md`).
- **RN color rule:** React Native cannot render `oklch(...)` color strings. Every hued surface from the mockups (FoodTile, macro dots, macro tiles, detected item chips) must convert its hue to an `hsl(...)` string via the helpers in `src/lib/hue.ts`. Never pass an `oklch()` string to a style.
- **Palette source of truth:** `src/theme/tokens.ts` (generated Kora palette — indigo `primary #6b55df`, white background, navy foreground). Do NOT hand-edit `tokens.ts`. All color comes from `useTheme()`; all radii/spacing from the theme. No per-feature hardcoded colors, radii, or shadows.
- **Editorial type:** numerals (kcal, %, weights, grams, times) render in the mono family (`theme.fonts.mono`). Overlines are 11px, `letterSpacing 0.09*fontSize`≈1, uppercase, `weight 700`, muted. Screen titles 28px/800/-0.03em. Home Otto headline 27px/800/-0.03em with the kcal figure in `primary`.
- **Tests:** TDD. Every new component/helper gets a jest-expo test. `render()` from RNTL v14 is async — `await`/`findBy*`. Run tests **foreground**: `cd apps/mobile && npm test`. Screens get a smoke test (renders key copy without throwing).
- **UI-fidelity GATE (spec §5):** each screen is reviewed against its `ui_kits/kora` mockup screenshot via `idb` before its task is accepted. A functional-but-off-design screen is a failed review, not a pass.
- **Commits:** conventional-commit, single-line, no signatures. Frequent commits (one per task minimum).
- **Immutability:** never mutate props/state objects; return new objects (spread).

## Branch

All work lands on a new branch `phase-1c-ui-fidelity` cut from `phase-1b-hardening` (confirmed with user). Task 1 Step 1 creates it.

## Mockups (source of truth) — read before the matching task

- Shared chrome: `design-system/ui_kits/kora/Chrome.jsx` (`StatusBar`, `TabBar`, `FoodTile`, `Sheet`, `ScreenHeader`)
- `HomeScreen.jsx`, `DiaryScreen.jsx`, `ProgressScreen.jsx`, `Onboarding.jsx`, `MealDetail.jsx`
- `CaptureScreen.jsx` is the Phase-3 dark AI capture flow — **out of scope here**; the capture tab/hero route to the restyled manual `/log` for now.

## File Structure

**New shared infra (`apps/mobile/src/`):**
- `lib/hue.ts` — `tileBg/tileFg/dot/tileFaint(hue)` HSL converters + `MACRO` hue map.
- `lib/foodVisual.ts` — `foodVisual(name, mealSlot) → { hue, icon }` deterministic mapper.
- `components/Icon.tsx` — Lucide wrapper mapping mockup kebab names → components.
- `components/CircularProgress.tsx` — SVG ring with centered children slot (replaces flat `Ring`).
- `components/FoodTile.tsx` — hued single-tone tile + centered icon.
- `components/ScreenHeader.tsx` — overline + 28px title + right slot.
- `components/Avatar.tsx` — initials circle.
- `components/Stat.tsx` — label + mono value + unit (+ optional delta/trend).
- `components/Badge.tsx` — small pill (success/neutral) with optional icon.
- `components/Sheet.tsx` — bottom-sheet modal (scrim + handle + rounded top).
- `components/FloatingTabBar.tsx` — glassy floating pill tab bar with center capture button.
- `components/Overline.tsx` + `components/Numeral.tsx` — tiny editorial type helpers.

**Navigation restructure (`apps/mobile/app/`):**
- Create `app/(tabs)/_layout.tsx` (tabs + guard), `app/(tabs)/index.tsx` (Home), `app/(tabs)/diary.tsx`, `app/(tabs)/progress.tsx`, `app/(tabs)/more.tsx`.
- Create `app/meal.tsx` (transparent-modal Meal detail via `Sheet`).
- Delete `app/index.tsx` (Home moves into the tabs group).
- Modify `app/_layout.tsx` (register `(tabs)` + `meal` modal).
- Modify `app/log.tsx`, `app/onboarding.tsx` (editorial restyle).

**Theme (`apps/mobile/src/theme/`):**
- Modify `index.ts` — add `fonts.mono` and `shadows` presets.

---

## Task 1: Dependencies, theme fonts/shadows, and the Icon wrapper

**Files:**
- Modify: `apps/mobile/package.json` (deps added by `expo install`)
- Modify: `apps/mobile/src/theme/index.ts`
- Create: `apps/mobile/src/theme/__tests__/fonts.test.ts`
- Create: `apps/mobile/src/components/Icon.tsx`
- Create: `apps/mobile/src/components/__tests__/Icon.test.tsx`

**Interfaces:**
- Produces: `useTheme()` returns additionally `fonts: { mono: string }` and `shadows: { sm; md; lg }` (each an RN shadow style object with `shadowColor/shadowOpacity/shadowRadius/shadowOffset/elevation`).
- Produces: `<Icon name={string} size={number} color={string} strokeWidth?={number} />` mapping mockup kebab names to Lucide icons; unknown names fall back to a dot (`Circle`).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git checkout phase-1b-hardening
git checkout -b phase-1c-ui-fidelity
```

- [ ] **Step 2: Install dependencies (SDK-57 compatible)**

```bash
cd apps/mobile
npx expo install react-native-svg lucide-react-native expo-blur
```
Expected: `package.json` gains `react-native-svg`, `lucide-react-native`, `expo-blur`. Commit the lockfile too.

- [ ] **Step 3: Write the failing theme test**

Create `apps/mobile/src/theme/__tests__/fonts.test.ts`:
```ts
import { renderHook } from "@testing-library/react-native";
import { useTheme } from "@/theme";

test("theme exposes a mono font family and shadow presets", () => {
  const { result } = renderHook(() => useTheme());
  expect(typeof result.current.fonts.mono).toBe("string");
  expect(result.current.fonts.mono.length).toBeGreaterThan(0);
  expect(result.current.shadows.sm.shadowRadius).toBeGreaterThan(0);
  expect(result.current.shadows.lg.elevation).toBeGreaterThan(result.current.shadows.sm.elevation);
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- fonts.test`
Expected: FAIL (`fonts` is undefined).

- [ ] **Step 5: Extend the theme**

Replace `apps/mobile/src/theme/index.ts` with:
```ts
import { Platform, useColorScheme } from "react-native";
import { darkColors, fontSize, lightColors, radius, spacing } from "./tokens";

export type ThemeColors = Record<keyof typeof lightColors, string>;

const fonts = {
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
};

function makeShadows(scheme: "light" | "dark") {
  const shadowColor = scheme === "dark" ? "#000000" : "#0f1729";
  return {
    sm: { shadowColor, shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    md: { shadowColor, shadowOpacity: 0.1, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    lg: { shadowColor, shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 9 },
  } as const;
}

export function useTheme() {
  const scheme = useColorScheme() ?? "light";
  const colors = scheme === "dark" ? darkColors : lightColors;
  return { colors, spacing, radius, fontSize, fonts, shadows: makeShadows(scheme), scheme } as const;
}
```

- [ ] **Step 6: Run the theme test, verify it passes**

Run: `cd apps/mobile && npm test -- fonts.test`
Expected: PASS.

- [ ] **Step 7: Write the failing Icon test**

Create `apps/mobile/src/components/__tests__/Icon.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import { Icon } from "@/components/Icon";

test("renders a known icon by mockup kebab name", async () => {
  const { toJSON } = render(<Icon name="sparkles" size={20} color="#000" />);
  expect(toJSON()).toBeTruthy();
});

test("falls back without throwing on an unknown name", async () => {
  const { toJSON } = render(<Icon name="not-a-real-icon" size={20} color="#000" />);
  expect(toJSON()).toBeTruthy();
});
```

- [ ] **Step 8: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- Icon.test`
Expected: FAIL (module not found).

- [ ] **Step 9: Implement the Icon wrapper**

Create `apps/mobile/src/components/Icon.tsx`. Map only names used across the in-scope screens. **Before committing, confirm each imported name exists in the installed `lucide-react-native` version** (`node -e "console.log(Object.keys(require('lucide-react-native')).slice(0,5))"` to sanity-check the module, then check specific names); if a name is missing in this version, substitute the nearest Lucide icon and update the map.
```tsx
import {
  House, BookOpen, Camera, LineChart, Grid2x2, Sparkles, MessageCircle, Mic, Plus,
  Utensils, TrendingDown, TrendingUp, Minus, Check, ArrowRight, Trash2,
  Drumstick, Leaf, Wheat, Egg, Fish, Apple, Coffee, Soup, Salad, Circle,
  type LucideIcon,
} from "lucide-react-native";

const MAP: Record<string, LucideIcon> = {
  house: House, "book-open": BookOpen, camera: Camera, "chart-line": LineChart,
  "grid-2x2": Grid2x2, sparkles: Sparkles, "message-circle": MessageCircle, mic: Mic,
  plus: Plus, utensils: Utensils, "trending-down": TrendingDown, "trending-up": TrendingUp,
  minus: Minus, check: Check, "arrow-right": ArrowRight, "trash-2": Trash2,
  drumstick: Drumstick, leaf: Leaf, wheat: Wheat, egg: Egg, fish: Fish, apple: Apple,
  coffee: Coffee, soup: Soup, salad: Salad,
};

type Props = { name: string; size?: number; color: string; strokeWidth?: number };

export function Icon({ name, size = 20, color, strokeWidth = 2 }: Props) {
  const Cmp = MAP[name] ?? Circle;
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}
```

- [ ] **Step 10: Run the Icon test, verify it passes**

Run: `cd apps/mobile && npm test -- Icon.test`
Expected: PASS. If `react-native-svg` fails to import under jest, add to `apps/mobile/package.json` jest config: `"moduleNameMapper": { "^react-native-svg$": "react-native-svg/mock" }` (react-native-svg ships a jest mock) and re-run.

- [ ] **Step 11: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/src/theme/index.ts apps/mobile/src/theme/__tests__/fonts.test.ts apps/mobile/src/components/Icon.tsx apps/mobile/src/components/__tests__/Icon.test.tsx
git commit -m "feat(mobile): add svg/lucide/blur deps, mono+shadow theme, Icon wrapper"
```

---

## Task 2: CircularProgress (SVG ring)

**Files:**
- Create: `apps/mobile/src/components/CircularProgress.tsx`
- Create: `apps/mobile/src/components/__tests__/CircularProgress.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` (colors, fonts).
- Produces: `<CircularProgress value={number} max={number} size?={number} stroke?={number} color?={string} track?={string}>{children}</CircularProgress>` — draws a background track + a foreground arc for `clamp(value/max, 0..1)`, arc starting at 12 o'clock, and centers `children` over the ring.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/CircularProgress.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import { AppText } from "@/components/Text";
import { CircularProgress } from "@/components/CircularProgress";

test("renders centered children over the ring", async () => {
  const { findByText } = render(
    <CircularProgress value={63} max={100} size={54} stroke={6}>
      <AppText>63%</AppText>
    </CircularProgress>,
  );
  expect(await findByText("63%")).toBeTruthy();
});

test("does not throw when max is zero", () => {
  expect(() => render(<CircularProgress value={5} max={0} />)).not.toThrow();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- CircularProgress.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/mobile/src/components/CircularProgress.tsx`:
```tsx
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useTheme } from "@/theme";

type Props = {
  value: number;
  max: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
};

export function CircularProgress({ value, max, size = 54, stroke = 6, color, track, children }: Props) {
  const { colors } = useTheme();
  const arcColor = color ?? colors.primary;
  const trackColor = track ?? colors.muted;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const half = size / 2;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={half} cy={half} r={r} stroke={trackColor} strokeWidth={stroke} fill="none" />
        <Circle
          cx={half}
          cy={half}
          r={r}
          stroke={arcColor}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${half} ${half})`}
        />
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>{children}</View>
    </View>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/mobile && npm test -- CircularProgress.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/CircularProgress.tsx apps/mobile/src/components/__tests__/CircularProgress.test.tsx
git commit -m "feat(mobile): real circular progress ring via react-native-svg"
```

---

## Task 3: Hue helpers, foodVisual mapper, and FoodTile

**Files:**
- Create: `apps/mobile/src/lib/hue.ts`
- Create: `apps/mobile/src/lib/__tests__/hue.test.ts`
- Create: `apps/mobile/src/lib/foodVisual.ts`
- Create: `apps/mobile/src/lib/__tests__/foodVisual.test.ts`
- Create: `apps/mobile/src/components/FoodTile.tsx`
- Create: `apps/mobile/src/components/__tests__/FoodTile.test.tsx`

**Interfaces:**
- Produces (`hue.ts`): `tileBg(hue) → hsl string` (pale bg, mockup `oklch(0.93 0.06 h)`), `tileFg(hue) → hsl string` (saturated icon, `oklch(0.5 0.12 h)`), `tileFaint(hue) → hsl string` (very pale tile bg for macro tiles, `oklch(0.96 0.03 h)`), `dot(hue) → hsl string` (`oklch(0.6 0.15 h)`), and `MACRO = { protein:{hue:285}, carbs:{hue:45}, fat:{hue:30} }`.
- Produces (`foodVisual.ts`): `foodVisual(name: string, mealSlot?: string) → { hue: number; icon: string }` — deterministic; icon is a mockup kebab name valid in `Icon`.
- Produces (`FoodTile.tsx`): `<FoodTile hue={number} icon={string} size?={number} radius?={number} />` — hued rounded square with a centered icon.

- [ ] **Step 1: Write the failing hue test**

Create `apps/mobile/src/lib/__tests__/hue.test.ts`:
```ts
import { tileBg, tileFg, tileFaint, dot, MACRO } from "@/lib/hue";

test("hue helpers return hsl strings, never oklch", () => {
  for (const fn of [tileBg, tileFg, tileFaint, dot]) {
    const out = fn(150);
    expect(out.startsWith("hsl(")).toBe(true);
    expect(out).not.toContain("oklch");
  }
});

test("MACRO exposes protein/carbs/fat hues", () => {
  expect(MACRO.protein.hue).toBe(285);
  expect(MACRO.carbs.hue).toBe(45);
  expect(MACRO.fat.hue).toBe(30);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- hue.test`
Expected: FAIL.

- [ ] **Step 3: Implement `hue.ts`**

Create `apps/mobile/src/lib/hue.ts`:
```ts
// RN cannot render oklch(); these approximate the mockup's single-hue tints in hsl().
export const tileBg = (hue: number): string => `hsl(${hue}, 45%, 90%)`;
export const tileFg = (hue: number): string => `hsl(${hue}, 55%, 42%)`;
export const tileFaint = (hue: number): string => `hsl(${hue}, 30%, 95%)`;
export const dot = (hue: number): string => `hsl(${hue}, 60%, 50%)`;

export const MACRO = {
  protein: { hue: 285 },
  carbs: { hue: 45 },
  fat: { hue: 30 },
} as const;
```

- [ ] **Step 4: Run the hue test, verify it passes**

Run: `cd apps/mobile && npm test -- hue.test`
Expected: PASS.

- [ ] **Step 5: Write the failing foodVisual test**

Create `apps/mobile/src/lib/__tests__/foodVisual.test.ts`:
```ts
import { foodVisual } from "@/lib/foodVisual";

test("is deterministic for the same name", () => {
  expect(foodVisual("Grilled chicken breast")).toEqual(foodVisual("Grilled chicken breast"));
});

test("maps keywords to sensible icons", () => {
  expect(foodVisual("Grilled chicken breast").icon).toBe("drumstick");
  expect(foodVisual("Steamed broccoli salad").icon).toBe("leaf");
  expect(foodVisual("Brown rice").icon).toBe("wheat");
});

test("falls back by meal slot then to utensils", () => {
  expect(foodVisual("Mystery plate", "breakfast").icon).toBe("coffee");
  expect(foodVisual("Mystery plate", "dinner").icon).toBe("utensils");
});

test("hue is within 0..360", () => {
  const { hue } = foodVisual("anything");
  expect(hue).toBeGreaterThanOrEqual(0);
  expect(hue).toBeLessThan(360);
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- foodVisual.test`
Expected: FAIL.

- [ ] **Step 7: Implement `foodVisual.ts`**

Create `apps/mobile/src/lib/foodVisual.ts`:
```ts
const HUES = [30, 70, 150, 200, 285, 340];

const KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/chicken|beef|steak|pork|drumstick|meat|lamb|turkey/i, "drumstick"],
  [/salmon|fish|tuna|prawn|shrimp/i, "fish"],
  [/broccoli|salad|spinach|kale|lettuce|greens|veg/i, "leaf"],
  [/rice|bread|oat|pasta|noodle|wheat|grain|cereal|toast/i, "wheat"],
  [/egg|omelet|omelette/i, "egg"],
  [/apple|banana|berry|fruit|orange|mango/i, "apple"],
  [/coffee|latte|espresso|cappuccino|tea/i, "coffee"],
  [/soup|stew|broth|curry/i, "soup"],
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function iconForName(name: string, mealSlot?: string): string {
  for (const [re, icon] of KEYWORDS) if (re.test(name)) return icon;
  if (mealSlot === "breakfast") return "coffee";
  return "utensils";
}

export function foodVisual(name: string, mealSlot?: string): { hue: number; icon: string } {
  return { hue: HUES[hashString(name) % HUES.length], icon: iconForName(name, mealSlot) };
}
```

- [ ] **Step 8: Run the foodVisual test, verify it passes**

Run: `cd apps/mobile && npm test -- foodVisual.test`
Expected: PASS.

- [ ] **Step 9: Write the failing FoodTile test**

Create `apps/mobile/src/components/__tests__/FoodTile.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import { FoodTile } from "@/components/FoodTile";

test("renders without throwing at a given hue/icon", () => {
  const { toJSON } = render(<FoodTile hue={150} icon="leaf" size={56} />);
  expect(toJSON()).toBeTruthy();
});
```

- [ ] **Step 10: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- FoodTile.test`
Expected: FAIL.

- [ ] **Step 11: Implement `FoodTile.tsx`**

Create `apps/mobile/src/components/FoodTile.tsx`:
```tsx
import { View } from "react-native";
import { Icon } from "./Icon";
import { tileBg, tileFg } from "@/lib/hue";
import { useTheme } from "@/theme";

type Props = { hue?: number; icon?: string; size?: number; radius?: number };

export function FoodTile({ hue = 150, icon = "utensils", size = 56, radius }: Props) {
  const { radius: r } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? r.lg,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: tileBg(hue),
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} color={tileFg(hue)} />
    </View>
  );
}
```

- [ ] **Step 12: Run the FoodTile test, verify it passes**

Run: `cd apps/mobile && npm test -- FoodTile.test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/mobile/src/lib/hue.ts apps/mobile/src/lib/foodVisual.ts apps/mobile/src/lib/__tests__/hue.test.ts apps/mobile/src/lib/__tests__/foodVisual.test.ts apps/mobile/src/components/FoodTile.tsx apps/mobile/src/components/__tests__/FoodTile.test.tsx
git commit -m "feat(mobile): hue helpers, foodVisual mapper, FoodTile"
```

---

## Task 4: ScreenHeader, Avatar, Stat, Badge, Overline, Numeral

**Files:**
- Create: `apps/mobile/src/components/Overline.tsx`
- Create: `apps/mobile/src/components/Numeral.tsx`
- Create: `apps/mobile/src/components/ScreenHeader.tsx`
- Create: `apps/mobile/src/components/Avatar.tsx`
- Create: `apps/mobile/src/components/Stat.tsx`
- Create: `apps/mobile/src/components/Badge.tsx`
- Create: `apps/mobile/src/components/__tests__/editorial-primitives.test.tsx`

**Interfaces:**
- Produces: `<Overline>{text}</Overline>` (11px uppercase tracked muted 700).
- Produces: `<Numeral size?={number} weight?={"700"|"800"} color?={string} style?>{children}</Numeral>` (mono numerals).
- Produces: `<ScreenHeader overline?={string} title={string} right?={ReactNode} />`.
- Produces: `<Avatar initials={string} size?={number} />`.
- Produces: `<Stat label={string} value={string} unit?={string} delta?={string} trend?={"up"|"down"} />`.
- Produces: `<Badge variant?={"success"|"neutral"} icon?={string}>{children}</Badge>`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/editorial-primitives.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Avatar } from "@/components/Avatar";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";

test("ScreenHeader shows overline and title", async () => {
  const { findByText } = render(<ScreenHeader overline="This week" title="Diary" />);
  expect(await findByText("This week")).toBeTruthy();
  expect(await findByText("Diary")).toBeTruthy();
});

test("Avatar shows initials", async () => {
  const { findByText } = render(<Avatar initials="AS" />);
  expect(await findByText("AS")).toBeTruthy();
});

test("Stat shows label, value and unit", async () => {
  const { findByText } = render(<Stat label="Total intake" value="1,252" unit="kcal" />);
  expect(await findByText("Total intake")).toBeTruthy();
  expect(await findByText("1,252")).toBeTruthy();
  expect(await findByText("kcal")).toBeTruthy();
});

test("Badge renders its children", async () => {
  const { findByText } = render(<Badge variant="success">AI logged</Badge>);
  expect(await findByText("AI logged")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- editorial-primitives.test`
Expected: FAIL.

- [ ] **Step 3: Implement `Overline.tsx`**

```tsx
import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

export function Overline({ style, children, ...rest }: TextProps) {
  const { colors } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: colors.mutedForeground },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
```

- [ ] **Step 4: Implement `Numeral.tsx`**

```tsx
import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

type Props = TextProps & { size?: number; weight?: "700" | "800"; color?: string };

export function Numeral({ size = 16, weight = "800", color, style, children, ...rest }: Props) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      {...rest}
      style={[{ fontFamily: fonts.mono, fontSize: size, fontWeight: weight, letterSpacing: -0.3, color: color ?? colors.foreground }, style]}
    >
      {children}
    </Text>
  );
}
```

- [ ] **Step 5: Implement `ScreenHeader.tsx`**

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Overline } from "./Overline";

type Props = { overline?: string; title: string; right?: ReactNode };

export function ScreenHeader({ overline, title, right }: Props) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 }}>
      <View style={{ flex: 1 }}>
        {overline ? <Overline style={{ marginBottom: 3 }}>{overline}</Overline> : null}
        <AppText style={{ fontSize: 28, fontWeight: "800", letterSpacing: -0.84 }}>{title}</AppText>
      </View>
      {right}
    </View>
  );
}
```

- [ ] **Step 6: Implement `Avatar.tsx`**

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { initials: string; size?: number };

export function Avatar({ initials, size = 40 }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.secondary, alignItems: "center", justifyContent: "center" }}>
      <AppText style={{ fontSize: size * 0.38, fontWeight: "700", color: colors.secondaryForeground }}>{initials}</AppText>
    </View>
  );
}
```

- [ ] **Step 7: Implement `Stat.tsx`**

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { label: string; value: string; unit?: string; delta?: string; trend?: "up" | "down" };

export function Stat({ label, value, unit, delta, trend }: Props) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>{label}</AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <Numeral size={22}>{value}</Numeral>
        {unit ? <AppText muted style={{ fontSize: 12 }}>{unit}</AppText> : null}
      </View>
      {delta ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          {trend ? <Icon name={trend === "up" ? "trending-up" : "trending-down"} size={12} color={colors.success} /> : null}
          <AppText style={{ fontSize: 11, color: colors.success, fontWeight: "600" }}>{delta}</AppText>
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 8: Implement `Badge.tsx`**

```tsx
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Props = { variant?: "success" | "neutral"; icon?: string; children: ReactNode };

export function Badge({ variant = "neutral", icon, children }: Props) {
  const { colors, radius } = useTheme();
  const bg = variant === "success" ? "hsl(145, 55%, 92%)" : colors.secondary;
  const fg = variant === "success" ? "hsl(145, 60%, 30%)" : colors.secondaryForeground;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full, backgroundColor: bg }}>
      {icon ? <Icon name={icon} size={12} color={fg} /> : null}
      <AppText style={{ fontSize: 12, fontWeight: "700", color: fg }}>{children}</AppText>
    </View>
  );
}
```

- [ ] **Step 9: Run the test, verify it passes**

Run: `cd apps/mobile && npm test -- editorial-primitives.test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/components/Overline.tsx apps/mobile/src/components/Numeral.tsx apps/mobile/src/components/ScreenHeader.tsx apps/mobile/src/components/Avatar.tsx apps/mobile/src/components/Stat.tsx apps/mobile/src/components/Badge.tsx apps/mobile/src/components/__tests__/editorial-primitives.test.tsx
git commit -m "feat(mobile): editorial primitives — ScreenHeader, Avatar, Stat, Badge, Overline, Numeral"
```

---

## Task 5: Sheet (bottom-sheet modal primitive)

**Files:**
- Create: `apps/mobile/src/components/Sheet.tsx`
- Create: `apps/mobile/src/components/__tests__/Sheet.test.tsx`

**Interfaces:**
- Consumes: `useTheme()`.
- Produces: `<Sheet visible={boolean} onClose={() => void}>{children}</Sheet>` — RN `Modal` (`transparent`, `animationType="slide"`) with a dark scrim (tap to close), a top grab-handle, rounded top corners, `maxHeight 82%`, scrollable content.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/Sheet.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";
import { AppText } from "@/components/Text";
import { Sheet } from "@/components/Sheet";

test("shows content when visible", async () => {
  const { findByText } = render(
    <Sheet visible onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>,
  );
  expect(await findByText("Sheet body")).toBeTruthy();
});

test("hides content when not visible", () => {
  const { queryByText } = render(
    <Sheet visible={false} onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>,
  );
  expect(queryByText("Sheet body")).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- Sheet.test`
Expected: FAIL.

- [ ] **Step 3: Implement `Sheet.tsx`**

```tsx
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useTheme } from "@/theme";

type Props = { visible: boolean; onClose: () => void; children: ReactNode };

export function Sheet({ visible, onClose, children }: Props) {
  const { colors, radius, shadows } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(10,20,15,0.38)", justifyContent: "flex-end" }}>
        <Pressable
          onPress={() => {}}
          style={[
            { maxHeight: "82%", backgroundColor: colors.background, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"] },
            shadows.lg,
          ]}
        >
          <View style={{ alignItems: "center", paddingTop: 10 }}>
            <View style={{ width: 40, height: 5, borderRadius: 999, backgroundColor: colors.border }} />
          </View>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/mobile && npm test -- Sheet.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/Sheet.tsx apps/mobile/src/components/__tests__/Sheet.test.tsx
git commit -m "feat(mobile): bottom-sheet modal primitive"
```

---

## Task 6: Meal detail modal route

**Read first:** `design-system/ui_kits/kora/MealDetail.jsx`.

**Files:**
- Create: `apps/mobile/app/meal.tsx`
- Create: `apps/mobile/app/__tests__/meal.test.tsx`

**Interfaces:**
- Consumes: `Sheet`, `FoodTile`, `Badge`, `AppText`, `Numeral`, `Overline`, `foodVisual`, `tileFaint`, `MACRO`, `useTheme`.
- Consumes route params (all strings via `useLocalSearchParams`): `name`, `mealSlot`, `time`, `kcal`, `protein`, `carbs`, `fat`.
- Produces: a transparent-modal screen at `/meal` that renders the meal-detail sheet. Opened via `router.push({ pathname: "/meal", params })`.
- **Placeholder note:** the per-item gram stepper + "Save changes"/delete from the mockup need an update/delete endpoint that does not exist yet — this pass renders the macro tiles + single logged item + a "Done" button (matches the mockup's shape; editing is deferred to a later phase).

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/meal.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ name: "Lunch", mealSlot: "lunch", time: "12:30", kcal: "410", protein: "48", carbs: "132", fat: "12" }),
  router: { back: jest.fn() },
}));

import MealDetail from "../meal";

test("renders meal name, kcal and macro tiles", async () => {
  const { findByText } = render(<MealDetail />);
  expect(await findByText("410")).toBeTruthy();
  expect(await findByText("Protein")).toBeTruthy();
  expect(await findByText("48g")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- meal.test`
Expected: FAIL.

- [ ] **Step 3: Implement `app/meal.tsx`**

```tsx
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { FoodTile } from "@/components/FoodTile";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

export default function MealDetail() {
  const { colors, radius, fonts } = useTheme();
  const p = useLocalSearchParams<{ name: string; mealSlot: string; time: string; kcal: string; protein: string; carbs: string; fat: string }>();
  const name = p.name ?? "Meal";
  const vis = foodVisual(name, p.mealSlot);
  const tiles: ReadonlyArray<readonly [string, string, number]> = [
    ["Protein", `${p.protein ?? 0}g`, MACRO.protein.hue],
    ["Carbs", `${p.carbs ?? 0}g`, MACRO.carbs.hue],
    ["Fat", `${p.fat ?? 0}g`, MACRO.fat.hue],
  ];
  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <Overline>{name} · {p.time}</Overline>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
              <Numeral size={24}>{p.kcal}</Numeral>
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 14 }}>kcal</AppText>
            </View>
          </View>
          <Badge variant="success" icon="sparkles">AI logged</Badge>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginBottom: 18 }}>
          {tiles.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{value}</Numeral>
            </View>
          ))}
        </View>

        <Overline>Items</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 8, marginBottom: 20 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={40} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 14, fontWeight: "600" }}>{name}</AppText>
            <AppText muted style={{ fontFamily: fonts.mono, fontSize: 12 }}>{p.kcal} kcal</AppText>
          </View>
        </View>

        <Button title="Done" onPress={() => router.back()} />
      </View>
    </Sheet>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/mobile && npm test -- meal.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/meal.tsx apps/mobile/app/__tests__/meal.test.tsx
git commit -m "feat(mobile): meal-detail modal sheet"
```

---

## Task 7: Tab shell — FloatingTabBar + (tabs) layout + guard + More

**Read first:** `design-system/ui_kits/kora/Chrome.jsx` (`TabBar`).

**Files:**
- Create: `apps/mobile/src/components/FloatingTabBar.tsx`
- Create: `apps/mobile/app/(tabs)/_layout.tsx`
- Create: `apps/mobile/app/(tabs)/index.tsx` (temporary Home stub — replaced in Task 8)
- Create: `apps/mobile/app/(tabs)/diary.tsx` (stub — replaced in Task 9)
- Create: `apps/mobile/app/(tabs)/progress.tsx` (stub — replaced in Task 10)
- Create: `apps/mobile/app/(tabs)/more.tsx`
- Modify: `apps/mobile/app/_layout.tsx`
- Delete: `apps/mobile/app/index.tsx`
- Move test: `apps/mobile/app/__tests__/index.test.tsx` → update its import to `../(tabs)/index` (see Step 7)
- Create: `apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx`

**Interfaces:**
- Produces: `<FloatingTabBar {...BottomTabBarProps} />` — a glassy floating pill: Home, Diary, center **capture** button (sparkles, routes to `/log`), Progress, More. Active tab tinted `primary`; inactive `mutedForeground`.
- The `(tabs)/_layout.tsx` holds the auth guard (`onAuthStateChanged` → `/sign-in`) and onboarding redirect (`profile.onboarded_at === null` → `/onboarding`), moved verbatim from the old `app/index.tsx`.

- [ ] **Step 1: Write the failing FloatingTabBar test**

Create `apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx`:
```tsx
import { render, fireEvent } from "@testing-library/react-native";

const push = jest.fn();
jest.mock("expo-router", () => ({ router: { push } }));

import { FloatingTabBar } from "@/components/FloatingTabBar";

const props = {
  state: { index: 0, routes: [{ key: "index", name: "index" }, { key: "diary", name: "diary" }, { key: "progress", name: "progress" }, { key: "more", name: "more" }] },
  navigation: { navigate: jest.fn(), emit: () => ({ defaultPrevented: false }) },
} as never;

test("renders tab labels and a capture button", async () => {
  const { findByLabelText } = render(<FloatingTabBar {...props} />);
  expect(await findByLabelText("Home")).toBeTruthy();
  expect(await findByLabelText("Capture")).toBeTruthy();
});

test("capture button routes to /log", async () => {
  const { findByLabelText } = render(<FloatingTabBar {...props} />);
  fireEvent.press(await findByLabelText("Capture"));
  expect(push).toHaveBeenCalledWith("/log");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- FloatingTabBar.test`
Expected: FAIL.

- [ ] **Step 3: Implement `FloatingTabBar.tsx`**

```tsx
import { Pressable, View } from "react-native";
import { BlurView } from "expo-blur";
import { router } from "expo-router";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

const TAB_META: Record<string, { icon: string; label: string }> = {
  index: { icon: "house", label: "Home" },
  diary: { icon: "book-open", label: "Diary" },
  progress: { icon: "chart-line", label: "Progress" },
  more: { icon: "grid-2x2", label: "More" },
};

const ORDER_LEFT = ["index", "diary"];
const ORDER_RIGHT = ["progress", "more"];

export function FloatingTabBar({ state, navigation }: BottomTabBarProps) {
  const { colors, radius, shadows } = useTheme();
  const activeName = state.routes[state.index]?.name;

  const tab = (name: string) => {
    const meta = TAB_META[name];
    if (!meta) return null;
    const on = activeName === name;
    return (
      <Pressable
        key={name}
        accessibilityLabel={meta.label}
        accessibilityRole="button"
        onPress={() => navigation.navigate(name)}
        style={{ width: 52, height: 52, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.secondary : "transparent" }}
      >
        <Icon name={meta.icon} size={22} color={on ? colors.primary : colors.mutedForeground} strokeWidth={on ? 2.5 : 2} />
      </Pressable>
    );
  };

  return (
    <View style={{ position: "absolute", left: 0, right: 0, bottom: 22, alignItems: "center" }} pointerEvents="box-none">
      <BlurView
        intensity={40}
        tint="light"
        style={[
          { flexDirection: "row", alignItems: "center", gap: 2, padding: 7, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, overflow: "hidden", backgroundColor: colors.card + "AE" },
          shadows.lg,
        ]}
      >
        {ORDER_LEFT.map(tab)}
        <Pressable
          accessibilityLabel="Capture"
          accessibilityRole="button"
          onPress={() => router.push("/log")}
          style={[{ width: 52, height: 52, marginHorizontal: 2, borderRadius: radius.full, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }, shadows.md]}
        >
          <Icon name="sparkles" size={24} color={colors.primaryForeground} />
        </Pressable>
        {ORDER_RIGHT.map(tab)}
      </BlurView>
    </View>
  );
}
```

- [ ] **Step 4: Run the FloatingTabBar test, verify it passes**

Run: `cd apps/mobile && npm test -- FloatingTabBar.test`
Expected: PASS. If `@react-navigation/bottom-tabs` types are missing, they are transitively present via `expo-router`; if the import path errors, change the type import to `import type { BottomTabBarProps } from "expo-router";` (Expo Router re-exports it) or drop the annotation and type `props` as `any` at the call boundary — the runtime shape is what matters.

- [ ] **Step 5: Create tab stubs**

`apps/mobile/app/(tabs)/index.tsx` (temporary — replaced in Task 8):
```tsx
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

export default function Home() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <AppText>Home</AppText>
    </View>
  );
}
```
Create `apps/mobile/app/(tabs)/diary.tsx` and `apps/mobile/app/(tabs)/progress.tsx` as identical stubs with `AppText>Diary</` and `AppText>Progress</` respectively (replaced in Tasks 9/10).

`apps/mobile/app/(tabs)/more.tsx` (final):
```tsx
import { Pressable, ScrollView, View } from "react-native";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { useTheme } from "@/theme";

const ROWS = [
  { icon: "message-circle", label: "Coach" },
  { icon: "trending-up", label: "Insights" },
  { icon: "grid-2x2", label: "Add-ons" },
];

export default function More() {
  const { colors, spacing } = useTheme();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Your account" title="More" />
      <View style={{ paddingHorizontal: 20, gap: spacing.sm }}>
        {ROWS.map((r) => (
          <View key={r.label} style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
            <Icon name={r.icon} size={20} color={colors.primary} />
            <AppText style={{ fontSize: 15, fontWeight: "600" }}>{r.label}</AppText>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          onPress={() => auth && signOut(auth)}
          style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: spacing.md, marginTop: spacing.md }}
        >
          <AppText style={{ color: colors.destructive, fontWeight: "600" }}>Sign out</AppText>
        </Pressable>
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 6: Implement `(tabs)/_layout.tsx` with the guard**

```tsx
import { useEffect } from "react";
import { Tabs, router } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { useProfile } from "@/api/hooks";
import { FloatingTabBar } from "@/components/FloatingTabBar";
import { useTheme } from "@/theme";

export default function TabsLayout() {
  const { colors } = useTheme();
  const profile = useProfile();

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) router.replace("/sign-in");
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (profile.data && profile.data.onboarded_at === null) router.replace("/onboarding");
  }, [profile.data]);

  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="diary" />
      <Tabs.Screen name="progress" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}
```

- [ ] **Step 7: Update root `_layout.tsx`, delete old index, move its test**

Replace `apps/mobile/app/_layout.tsx`:
```tsx
import { useEffect } from "react";
import { Stack, router } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { isFirebaseConfigured } from "@/lib/firebase";

export default function RootLayout() {
  useEffect(() => {
    if (!isFirebaseConfigured) router.replace("/config-missing");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="meal" options={{ presentation: "transparentModal", animation: "fade" }} />
      </Stack>
    </QueryClientProvider>
  );
}
```
Delete the old Home: `git rm apps/mobile/app/index.tsx`.
Update `apps/mobile/app/__tests__/index.test.tsx`: change its import from `../index` to `../(tabs)/index`. (The stub only renders "Home"; adjust the assertion to `findByText("Home")` if the old test asserted dashboard copy — it will be re-strengthened in Task 8.)

- [ ] **Step 8: Run the full suite, verify green**

Run: `cd apps/mobile && npm test`
Expected: PASS (all).

- [ ] **Step 9: Launch the app and screenshot the tab bar (idb review gate)**

Ensure API + Metro are running (see plan footer "Running services"), the demo user is signed in, then:
```bash
IDB=~/Library/Python/3.9/bin/idb
SIM=AD109A46-2F99-43C3-8AAA-FEE68DC8499E
SHOT=/private/tmp/claude-502/-Users-Mahesh-Sangawar-personal-tesserix-new-kora/d8af5596-5ab2-4144-83f0-3c3c40a6eb6f/scratchpad/tabbar.png
$IDB screenshot --udid $SIM $SHOT
```
Read `tabbar.png` and confirm: floating glass pill, 4 icon tabs + center indigo sparkles button, active-tab tint. Compare against `Chrome.jsx` `TabBar`. Fix before accepting.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/components/FloatingTabBar.tsx apps/mobile/src/components/__tests__/FloatingTabBar.test.tsx "apps/mobile/app/(tabs)" apps/mobile/app/_layout.tsx apps/mobile/app/__tests__/index.test.tsx
git rm apps/mobile/app/index.tsx
git commit -m "feat(mobile): floating tab bar shell with auth/onboarding guard"
```

---

## Task 8: Home screen (editorial, Otto-led feed)

**Read first:** `design-system/ui_kits/kora/HomeScreen.jsx`. Intent: **conversational, Otto-led feed, NOT a calorie-tracker dashboard.**

**Files:**
- Create: `apps/mobile/src/components/home/FuelStrip.tsx`
- Create: `apps/mobile/src/components/home/FeedMeal.tsx`
- Create: `apps/mobile/src/components/home/CaptureHero.tsx`
- Replace: `apps/mobile/app/(tabs)/index.tsx`
- Replace: `apps/mobile/app/__tests__/index.test.tsx`

**Interfaces:**
- Consumes: `useProfile`, `useDashboard`, `useDayLogs` (existing `@/api/hooks`), `CircularProgress`, `FeedMeal`, `FuelStrip`, `CaptureHero`, `Avatar`, `Icon`, `foodVisual`, `dot`, `MACRO`.
- `FuelStrip({ eaten, goal, macros })` where `macros = { p, c, f, pGoal, cGoal, fGoal }`.
- `FeedMeal({ log, note, onOpen })` where `log: FoodLog`; renders a FoodTile row (mono time, name, meta, mono kcal) + optional Otto note line.
- `CaptureHero({ onPress })` — full-width primary "Snap a meal or tell Otto what you ate…" with camera + mic pills.

- [ ] **Step 1: Write the failing Home test**

Replace `apps/mobile/app/__tests__/index.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: () => () => {}, signOut: jest.fn() }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone", onboarded_at: "2026-07-01" } }),
  useDashboard: () => ({ data: { consumed: { kcal: 1252, protein_g: 96, carbs_g: 140, fat_g: 40 }, targets: { kcal: 2000, protein_g: 140, carbs_g: 220, fat_g: 70 }, water_ml: 1400, streak_days: 12 } }),
  useDayLogs: () => ({ data: [{ id: "1", description: "Greek yogurt bowl", meal_slot: "breakfast", kcal: 320, protein_g: 24, carbs_g: 30, fat_g: 10, logged_at: "2026-07-24T08:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }] }),
}));

import Home from "../(tabs)/index";

test("Home shows the Otto editorial headline with kcal-left and the capture hero", async () => {
  const { findByText } = render(<Home />);
  expect(await findByText(/strong day/i)).toBeTruthy();
  expect(await findByText(/Snap a meal/i)).toBeTruthy();
  expect(await findByText("Greek yogurt bowl")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- index.test`
Expected: FAIL.

- [ ] **Step 3: Implement `CaptureHero.tsx`**

```tsx
import { Pressable, View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { useTheme } from "@/theme";

export function CaptureHero({ onPress }: { onPress: () => void }) {
  const { colors, radius, shadows } = useTheme();
  const pill = (icon: string) => (
    <View style={{ width: 34, height: 34, borderRadius: radius.full, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={17} color={colors.primaryForeground} />
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingLeft: 18, paddingRight: 14, borderRadius: radius["2xl"], backgroundColor: colors.primary }, shadows.lg]}
    >
      <Icon name="sparkles" size={22} color={colors.primaryForeground} />
      <AppText style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.primaryForeground }}>Snap a meal or tell Otto what you ate…</AppText>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {pill("camera")}
        {pill("mic")}
      </View>
    </Pressable>
  );
}
```

- [ ] **Step 4: Implement `FuelStrip.tsx`**

```tsx
import { View } from "react-native";
import { CircularProgress } from "@/components/CircularProgress";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { dot, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

type Macros = { p: number; c: number; f: number; pGoal: number; cGoal: number; fGoal: number };

export function FuelStrip({ eaten, goal, macros }: { eaten: number; goal: number; macros: Macros }) {
  const { colors, radius, fonts, shadows } = useTheme();
  const pct = goal > 0 ? Math.round(Math.min(100, (eaten / goal) * 100)) : 0;
  const rows: ReadonlyArray<readonly [string, number, number, number]> = [
    ["P", macros.p, macros.pGoal, MACRO.protein.hue],
    ["C", macros.c, macros.cGoal, MACRO.carbs.hue],
    ["F", macros.f, macros.fGoal, MACRO.fat.hue],
  ];
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 16, padding: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl }, shadows.sm]}>
      <CircularProgress value={eaten} max={goal} size={54} stroke={6}>
        <Numeral size={11} weight="800">{pct}%</Numeral>
      </CircularProgress>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
          <Numeral size={17}>{Math.max(0, goal - eaten).toLocaleString()}</Numeral>
          <AppText muted style={{ fontSize: 12 }}>kcal left · {eaten.toLocaleString()} of {goal.toLocaleString()}</AppText>
        </View>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
          {rows.map(([label, v, g, hue]) => (
            <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: dot(hue) }} />
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 11 }}>{label} {Math.round(v)}/{Math.round(g)}g</AppText>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
```

- [ ] **Step 5: Implement `FeedMeal.tsx`**

```tsx
import { Pressable, View } from "react-native";
import { FoodTile } from "@/components/FoodTile";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Icon } from "@/components/Icon";
import { foodVisual } from "@/lib/foodVisual";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function FeedMeal({ log, note, onOpen }: { log: FoodLog; note?: string | null; onOpen: () => void }) {
  const { colors, radius, fonts, shadows } = useTheme();
  const vis = foodVisual(log.description, log.meal_slot);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onOpen}
        style={[{ flexDirection: "row", gap: 14, alignItems: "center", padding: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl }, shadows.sm]}
      >
        <FoodTile hue={vis.hue} icon={vis.icon} size={60} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText muted style={{ fontFamily: fonts.mono, fontSize: 12 }}>{timeOf(log.logged_at)}</AppText>
          <AppText numberOfLines={1} style={{ fontSize: 15, fontWeight: "700" }}>{log.description}</AppText>
          <AppText muted numberOfLines={1} style={{ fontSize: 12 }}>{log.meal_slot} · {Math.round(log.quantity_grams)}g</AppText>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Numeral size={16}>{Math.round(log.kcal)}</Numeral>
          <AppText muted style={{ fontFamily: fonts.mono, fontSize: 10 }}>kcal</AppText>
        </View>
      </Pressable>
      {note ? (
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingLeft: 8, paddingRight: 4 }}>
          <View style={{ marginTop: 2 }}><Icon name="sparkles" size={14} color={colors.primary} /></View>
          <AppText muted style={{ flex: 1, fontSize: 12.5, lineHeight: 18 }}>{note}</AppText>
        </View>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 6: Implement `app/(tabs)/index.tsx`**

Static Otto copy is a placeholder (real coach is Phase 6). Greeting + date are derived; the kcal-left figure and feed are real.
```tsx
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { CaptureHero } from "@/components/home/CaptureHero";
import { FuelStrip } from "@/components/home/FuelStrip";
import { FeedMeal } from "@/components/home/FeedMeal";
import { useProfile, useDashboard, useDayLogs } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function dateLabel(): string {
  return new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function initials(name?: string): string {
  if (!name) return "K";
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

// Static Otto notes — placeholder until Phase 6 coaching.
const NOTES: Array<string | null> = ["Solid protein start — kept you full till noon.", null, "Smart snack choice.", null];

export default function Home() {
  const { colors, spacing } = useTheme();
  const profile = useProfile();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);

  const d = dashboard.data;
  const eaten = d?.consumed.kcal ?? 0;
  const goal = d?.targets.kcal ?? 0;
  const left = Math.max(0, goal - eaten);
  const loggedMeals = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({
      pathname: "/meal",
      params: { name: log.description, mealSlot: log.meal_slot, time: new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)) },
    });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: 130 }}>
      {/* header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 16 }}>
        <View>
          <Overline>{dateLabel()}</Overline>
          <AppText style={{ fontSize: 15, fontWeight: "600" }}>{greeting()}, {profile.data?.display_name?.split(" ")[0] ?? "there"}</AppText>
        </View>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }}>
            <Icon name="message-circle" size={19} color={colors.foreground} />
          </View>
          <Avatar initials={initials(profile.data?.display_name)} />
        </View>
      </View>

      {/* Otto editorial headline (static copy placeholder) */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 18 }}>
        <AppText style={{ fontSize: 27, lineHeight: 32, fontWeight: "800", letterSpacing: -0.81 }}>
          You're <AppText style={{ fontSize: 27, lineHeight: 32, fontWeight: "800", letterSpacing: -0.81, color: colors.primary }}>{left.toLocaleString()} kcal</AppText> from a strong day.
        </AppText>
        <AppText muted style={{ marginTop: 8, fontSize: 14.5, lineHeight: 22 }}>Protein's on track. A lean, high-protein dinner and you'll close every ring.</AppText>
      </View>

      {/* Capture hero */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 18 }}>
        <CaptureHero onPress={() => router.push("/log")} />
      </View>

      {/* Compact fuel summary */}
      {d ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <FuelStrip
            eaten={eaten}
            goal={goal}
            macros={{ p: d.consumed.protein_g, c: d.consumed.carbs_g, f: d.consumed.fat_g, pGoal: d.targets.protein_g, cGoal: d.targets.carbs_g, fGoal: d.targets.fat_g }}
          />
        </View>
      ) : null}

      {/* Today feed */}
      <View style={{ paddingHorizontal: 20 }}>
        <Overline style={{ fontSize: 13, letterSpacing: 1 }}>Today</Overline>
        <View style={{ gap: 14, marginTop: 12 }}>
          {loggedMeals.map((log, i) => (
            <FeedMeal key={log.id} log={log} note={NOTES[i % NOTES.length]} onOpen={() => openMeal(log)} />
          ))}
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 16, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.border }}
          >
            <Icon name="plus" size={20} color={colors.primary} />
            <AppText style={{ fontSize: 14, fontWeight: "600" }}>Add a meal</AppText>
            <AppText muted style={{ marginLeft: "auto", fontSize: 12 }}>Snap · say · scan</AppText>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 7: Run the Home test, verify it passes**

Run: `cd apps/mobile && npm test -- index.test`
Expected: PASS.

- [ ] **Step 8: idb screenshot review vs `HomeScreen.jsx`**

```bash
IDB=~/Library/Python/3.9/bin/idb
SIM=AD109A46-2F99-43C3-8AAA-FEE68DC8499E
SHOT=/private/tmp/claude-502/-Users-Mahesh-Sangawar-personal-tesserix-new-kora/d8af5596-5ab2-4144-83f0-3c3c40a6eb6f/scratchpad/home.png
$IDB screenshot --udid $SIM $SHOT
```
Read `home.png`; verify against `HomeScreen.jsx`: date overline + greeting + coach circle + avatar; 27px headline with indigo kcal span; indigo capture hero with camera/mic pills; FuelStrip with real ring + macro dots; Today feed of FoodTile rows with an Otto note line + dashed add-meal prompt. It must read as a **feed, not a dashboard**. Fix discrepancies before accepting.

- [ ] **Step 9: Commit**

```bash
git add "apps/mobile/app/(tabs)/index.tsx" apps/mobile/app/__tests__/index.test.tsx apps/mobile/src/components/home
git commit -m "feat(mobile): editorial Otto-led Home feed matching mockup"
```

---

## Task 9: Diary screen

**Read first:** `design-system/ui_kits/kora/DiaryScreen.jsx`.

**Files:**
- Replace: `apps/mobile/app/(tabs)/diary.tsx`
- Create: `apps/mobile/app/(tabs)/__tests__/diary.test.tsx`

**Interfaces:**
- Consumes: `useDashboard(date)`, `useDayLogs(date)`, `ScreenHeader`, `FoodTile`, `Card`, `Stat`, `Numeral`, `Overline`, `foodVisual`.
- Behavior: a 7-day week strip (Mon→Sun of the current week) with today highlighted and a selectable day; the selected day drives the stat card (Total intake / Remaining / Water — real via `useDashboard(selected)`) and a vertical **timeline** of that day's logs (real via `useDayLogs(selected)`). Tapping a timeline row opens `/meal`.
- **Note:** the little per-day dot under each week cell marks days ≤ today (loggable); it is not a per-day total (that would cost 7 queries on a shared db-f1-micro — deferred).

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/(tabs)/__tests__/diary.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useDashboard: () => ({ data: { consumed: { kcal: 1252 }, targets: { kcal: 2000 }, water_ml: 1400 } }),
  useDayLogs: () => ({ data: [{ id: "1", description: "Grilled salmon", meal_slot: "dinner", kcal: 520, protein_g: 40, carbs_g: 10, fat_g: 30, logged_at: "2026-07-24T19:00:00Z", provenance: "manual", quantity_grams: 200, source: "manual" }] }),
}));

import Diary from "../diary";

test("Diary shows header, timeline and a logged meal", async () => {
  const { findByText } = render(<Diary />);
  expect(await findByText("Diary")).toBeTruthy();
  expect(await findByText("Timeline")).toBeTruthy();
  expect(await findByText("Grilled salmon")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- diary.test`
Expected: FAIL.

- [ ] **Step 3: Implement `app/(tabs)/diary.tsx`**

```tsx
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { FoodTile } from "@/components/FoodTile";
import { useDashboard, useDayLogs } from "@/api/hooks";
import { foodVisual } from "@/lib/foodVisual";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

function weekDates(): Date[] {
  const now = new Date();
  const monday = new Date(now);
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  monday.setDate(now.getDate() - day);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}
const iso = (d: Date) => d.toLocaleDateString("en-CA");
const timeOf = (s: string) => new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function Diary() {
  const { colors, radius, spacing } = useTheme();
  const week = weekDates();
  const todayIso = iso(new Date());
  const [selected, setSelected] = useState(todayIso);
  const dashboard = useDashboard(selected);
  const logs = useDayLogs(selected);

  const d = dashboard.data;
  const total = Math.round(d?.consumed.kcal ?? 0);
  const remaining = Math.max(0, Math.round((d?.targets.kcal ?? 0) - (d?.consumed.kcal ?? 0)));
  const water = ((d?.water_ml ?? 0) / 1000).toFixed(1);
  const logged = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({ pathname: "/meal", params: { name: log.description, mealSlot: log.meal_slot, time: timeOf(log.logged_at), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)) } });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}>
      <ScreenHeader overline="This week" title="Diary" />

      {/* week strip */}
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        {week.map((date, i) => {
          const dISO = iso(date);
          const on = dISO === selected;
          const loggable = dISO <= todayIso;
          return (
            <Pressable
              key={dISO}
              accessibilityRole="button"
              onPress={() => setSelected(dISO)}
              style={{ flex: 1, borderRadius: radius.lg, borderWidth: on ? 0 : 1, borderColor: colors.border, backgroundColor: on ? colors.primary : colors.card, paddingVertical: 10, alignItems: "center", gap: 4 }}
            >
              <AppText style={{ fontSize: 11, fontWeight: "600", color: on ? colors.primaryForeground : colors.mutedForeground }}>{DOW[date.getDay()]}</AppText>
              <AppText style={{ fontSize: 16, fontWeight: "700", color: on ? colors.primaryForeground : colors.foreground }}>{date.getDate()}</AppText>
              <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: loggable ? (on ? colors.primaryForeground : colors.primary) : "transparent" }} />
            </Pressable>
          );
        })}
      </View>

      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <Stat label="Total intake" value={total.toLocaleString()} unit="kcal" />
          <View style={{ height: 40, width: 1, backgroundColor: colors.border }} />
          <Stat label="Remaining" value={remaining.toLocaleString()} unit="kcal" />
          <View style={{ height: 40, width: 1, backgroundColor: colors.border }} />
          <Stat label="Water" value={water} unit="L" />
        </Card>

        <Overline style={{ fontSize: 13, letterSpacing: 1 }}>Timeline</Overline>
        <View style={{ marginTop: 10, paddingLeft: 20 }}>
          <View style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 2, backgroundColor: colors.border }} />
          {logged.length === 0 ? <AppText muted style={{ paddingVertical: 12 }}>Nothing logged this day.</AppText> : null}
          {logged.map((log) => {
            const vis = foodVisual(log.description, log.meal_slot);
            return (
              <Pressable key={log.id} accessibilityRole="button" onPress={() => openMeal(log)} style={{ flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 10 }}>
                <View style={{ position: "absolute", left: -18, top: 22, width: 10, height: 10, borderRadius: 999, backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.background }} />
                <FoodTile hue={vis.hue} icon={vis.icon} size={48} />
                <View style={{ flex: 1 }}>
                  <AppText muted style={{ fontSize: 12 }}>{timeOf(log.logged_at)}</AppText>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{log.description}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{log.meal_slot} · {Math.round(log.quantity_grams)}g</AppText>
                </View>
                <Numeral size={14} weight="700">{Math.round(log.kcal)}</Numeral>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 4: Run the Diary test, verify it passes**

Run: `cd apps/mobile && npm test -- diary.test`
Expected: PASS.

- [ ] **Step 5: idb screenshot review vs `DiaryScreen.jsx`**

```bash
$IDB screenshot --udid $SIM /private/tmp/.../scratchpad/diary.png   # (use the full scratchpad path as above)
```
Navigate to the Diary tab first (tap the Diary icon via `$IDB ui tap` or on-device). Verify: "This week"/"Diary" header, selectable week strip with today highlighted indigo, stat card (Total/Remaining/Water), vertical timeline with dots + FoodTiles. Compare to mockup; fix before accepting.

- [ ] **Step 6: Commit**

```bash
git add "apps/mobile/app/(tabs)/diary.tsx" "apps/mobile/app/(tabs)/__tests__/diary.test.tsx"
git commit -m "feat(mobile): editorial Diary — week strip + timeline"
```

---

## Task 10: Progress screen

**Read first:** `design-system/ui_kits/kora/ProgressScreen.jsx`.

**Files:**
- Create: `apps/mobile/src/components/progress/WeightChart.tsx`
- Replace: `apps/mobile/app/(tabs)/progress.tsx`
- Create: `apps/mobile/app/(tabs)/__tests__/progress.test.tsx`

**Interfaces:**
- Consumes: `useDashboard(today)` (for the real **Log streak** stat), `ScreenHeader`, `Card`, `Stat`, `Numeral`, `Badge`, `Button`, `WeightChart`, `useTheme`.
- `WeightChart({ points, labels })` — an SVG area+line trend (react-native-svg `Polyline` + `Polygon` + end dot).
- **Placeholder note:** weight tracking has no backend yet, so the weight series + Avg intake / Avg steps / Avg sleep are static sample data clearly matching the mockup shape; only **Log streak** is wired to real `dashboard.streak_days`. The range toggle (1W/1M/3M/1Y) is local UI state only.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/(tabs)/__tests__/progress.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useDashboard: () => ({ data: { streak_days: 12 } }) }));

import Progress from "../progress";

test("Progress shows the weight card and the real streak", async () => {
  const { findByText } = render(<Progress />);
  expect(await findByText("Progress")).toBeTruthy();
  expect(await findByText("Weight")).toBeTruthy();
  expect(await findByText("Log streak")).toBeTruthy();
  expect(await findByText("12")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- progress.test`
Expected: FAIL.

- [ ] **Step 3: Implement `WeightChart.tsx`**

```tsx
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Polygon, Polyline, Circle } from "react-native-svg";
import { useTheme } from "@/theme";

export function WeightChart({ points }: { points: number[] }) {
  const { colors } = useTheme();
  const w = 300;
  const h = 130;
  const pad = 10;
  const min = Math.min(...points) - 0.4;
  const max = Math.max(...points) + 0.4;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (points.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = points.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${h - pad} ${line} ${x(points.length - 1)},${h - pad}`;
  return (
    <View>
      <Svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
        <Defs>
          <LinearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={colors.primary} stopOpacity={0.22} />
            <Stop offset="100%" stopColor={colors.primary} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Polygon points={area} fill="url(#wg)" />
        <Polyline points={line} fill="none" stroke={colors.primary} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((v, i) => (
          <Circle key={i} cx={x(i)} cy={y(v)} r={i === points.length - 1 ? 4.5 : 2.5} fill={colors.primary} stroke={colors.background} strokeWidth={1.5} />
        ))}
      </Svg>
    </View>
  );
}
```

- [ ] **Step 4: Implement `app/(tabs)/progress.tsx`**

```tsx
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Numeral } from "@/components/Numeral";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { WeightChart } from "@/components/progress/WeightChart";
import { useDashboard } from "@/api/hooks";
import { useTheme } from "@/theme";

// Placeholder sample series — weight tracking is a later phase.
const WEIGHTS = [74.2, 74.0, 73.6, 73.7, 73.1, 72.8, 72.4];
const LABELS = ["Jul 17", "", "Jul 19", "", "Jul 21", "", "Jul 23"];
const RANGES = ["1W", "1M", "3M", "1Y"] as const;

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

export default function Progress() {
  const { colors, radius, fonts } = useTheme();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const dashboard = useDashboard(today());
  const streak = dashboard.data?.streak_days ?? 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: 8, paddingBottom: 140 }}>
      <ScreenHeader
        overline="Trends"
        title="Progress"
        right={
          <Pressable accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Icon name="sparkles" size={15} color={colors.foreground} />
            <AppText style={{ fontSize: 13, fontWeight: "600" }}>Weekly report</AppText>
          </Pressable>
        }
      />

      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Card style={{ padding: 18 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
            <View>
              <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>Weight</AppText>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                <Numeral size={30}>72.4</Numeral>
                <AppText muted style={{ fontSize: 14 }}>kg</AppText>
              </View>
            </View>
            <Badge variant="success" icon="trending-down">1.8 kg</Badge>
          </View>
          <WeightChart points={WEIGHTS} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
            {LABELS.map((l, i) => (
              <AppText key={i} muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{l}</AppText>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 6, marginTop: 14 }}>
            {RANGES.map((r) => {
              const on = range === r;
              return (
                <Pressable key={r} accessibilityRole="button" onPress={() => setRange(r)} style={{ flex: 1, paddingVertical: 7, borderRadius: radius.md, alignItems: "center", backgroundColor: on ? colors.secondary : "transparent" }}>
                  <AppText style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: "700", color: on ? colors.primary : colors.mutedForeground }}>{r}</AppText>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg intake" value="1,921" unit="kcal" delta="On target" trend="down" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Log streak" value={String(streak)} unit="days" delta="Keep it up" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg steps" value="8,240" delta="+6% wk" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg sleep" value="7.1" unit="hrs" /></Card>
        </View>
      </View>
    </ScrollView>
  );
}
```

- [ ] **Step 5: Run the Progress test, verify it passes**

Run: `cd apps/mobile && npm test -- progress.test`
Expected: PASS.

- [ ] **Step 6: idb screenshot review vs `ProgressScreen.jsx`**

Navigate to the Progress tab, screenshot to `scratchpad/progress.png`, Read it. Verify: "Trends"/"Progress" header + "Weekly report" button; weight card with 72.4 kg mono, success badge, area+line chart, date labels, 1W/1M/3M/1Y toggle; 2×2 stat grid with the real streak. Fix before accepting.

- [ ] **Step 7: Commit**

```bash
git add "apps/mobile/app/(tabs)/progress.tsx" "apps/mobile/app/(tabs)/__tests__/progress.test.tsx" apps/mobile/src/components/progress
git commit -m "feat(mobile): editorial Progress — weight chart + stat grid"
```

---

## Task 11: Onboarding (editorial restyle)

**Read first:** `design-system/ui_kits/kora/Onboarding.jsx`.

**Files:**
- Replace: `apps/mobile/app/onboarding.tsx`
- Modify: `apps/mobile/src/lib/__tests__/validateOnboarding.test.ts` (unchanged logic — no edit needed unless imports break)
- Create: `apps/mobile/app/__tests__/onboarding.test.tsx`

**Interfaces:**
- Consumes: `useSubmitOnboarding` (existing), `validateOnboardingNumbers` (existing), `GoalCard`, `Icon`, `Button`, `AppText`, `useTheme`.
- Keeps all functional TDEE fields (sex, activity, birth year, height, weight) — the mockup only shows the goal step, but the calc needs the rest. Match the mockup's **header + goal cards**, then present the remaining fields in the same editorial style below.
- Goal id mapping to the mockup icons: `fat_loss`→`trending-down`/"Lose weight", `maintenance`→`minus`/"Maintain", `muscle_gain`→`trending-up`/"Build muscle".

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/onboarding.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({ useSubmitOnboarding: () => ({ mutate: jest.fn(), isPending: false }) }));

import Onboarding from "../onboarding";

test("Onboarding shows the editorial hero and goal cards", async () => {
  const { findByText } = render(<Onboarding />);
  expect(await findByText(/Otto tracks it/i)).toBeTruthy();
  expect(await findByText("Lose weight")).toBeTruthy();
  expect(await findByText("Build muscle")).toBeTruthy();
  expect(await findByText("Get started")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- onboarding.test`
Expected: FAIL.

- [ ] **Step 3: Implement `app/onboarding.tsx`**

```tsx
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateOnboardingNumbers } from "@/lib/validateOnboarding";

const GOALS: Array<{ id: OnboardingInput["goal"]; icon: string; title: string; sub: string }> = [
  { id: "fat_loss", icon: "trending-down", title: "Lose weight", sub: "Gentle calorie deficit" },
  { id: "maintenance", icon: "minus", title: "Maintain", sub: "Stay where you are" },
  { id: "muscle_gain", icon: "trending-up", title: "Build muscle", sub: "Lean surplus + protein" },
];
const ACTIVITIES: OnboardingInput["activity_level"][] = ["sedentary", "light", "moderate", "active", "very_active"];

export default function Onboarding() {
  const { colors, radius, spacing, shadows } = useTheme();
  const submit = useSubmitOnboarding();
  const [goal, setGoal] = useState<OnboardingInput["goal"]>("fat_loss");
  const [sex, setSex] = useState<OnboardingInput["sex"]>("male");
  const [activity, setActivity] = useState<OnboardingInput["activity_level"]>("moderate");
  const [birthYear, setBirthYear] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [error, setError] = useState<string | null>(null);

  const inputStyle = { borderWidth: 1, borderColor: colors.input, borderRadius: radius.lg, padding: spacing.md, color: colors.foreground, minHeight: 48 } as const;

  function onSubmit() {
    setError(null);
    const v = validateOnboardingNumbers(birthYear, heightCm, weightKg);
    if (v) {
      setError(v);
      return;
    }
    const input: OnboardingInput = { sex, goal, activity_level: activity, birth_year: Number(birthYear), height_cm: Number(heightCm), weight_kg: Number(weightKg) };
    submit.mutate(input, { onSuccess: () => router.replace("/"), onError: () => setError("Please check your details and try again.") });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 24, paddingTop: 40, gap: spacing.md }}>
      {/* brand */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <View style={[{ width: 40, height: 40, borderRadius: radius.lg, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" }, shadows.md]}>
          <Icon name="sparkles" size={22} color={colors.primaryForeground} />
        </View>
        <AppText style={{ fontSize: 20, fontWeight: "800", letterSpacing: -0.4 }}>Kora</AppText>
      </View>

      <AppText style={{ fontSize: 32, fontWeight: "800", letterSpacing: -1.12, lineHeight: 34 }}>Snap it.{"\n"}Otto tracks it.</AppText>
      <AppText muted style={{ fontSize: 16, lineHeight: 24, marginBottom: 10 }}>Photo or chat — log meals in seconds and let AI handle the calories and macros.</AppText>

      <Overline>What's your goal?</Overline>
      <View style={{ gap: 10 }}>
        {GOALS.map((g) => {
          const on = goal === g.id;
          return (
            <Pressable
              key={g.id}
              accessibilityRole="button"
              onPress={() => setGoal(g.id)}
              style={[{ flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: radius.xl, backgroundColor: colors.card, borderWidth: 2, borderColor: on ? colors.primary : colors.border }, on ? shadows.md : null]}
            >
              <View style={{ width: 42, height: 42, borderRadius: radius.lg, backgroundColor: on ? colors.primary : colors.secondary, alignItems: "center", justifyContent: "center" }}>
                <Icon name={g.icon} size={20} color={on ? colors.primaryForeground : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={{ fontSize: 16, fontWeight: "700" }}>{g.title}</AppText>
                <AppText muted style={{ fontSize: 13 }}>{g.sub}</AppText>
              </View>
              <View style={{ width: 22, height: 22, borderRadius: 999, borderWidth: on ? 0 : 2, borderColor: colors.border, backgroundColor: on ? colors.primary : "transparent", alignItems: "center", justifyContent: "center" }}>
                {on ? <Icon name="check" size={14} color={colors.primaryForeground} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <Overline style={{ marginTop: 8 }}>About you</Overline>
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <View style={{ flex: 1 }}><Button title="Male" variant={sex === "male" ? "primary" : "secondary"} onPress={() => setSex("male")} /></View>
        <View style={{ flex: 1 }}><Button title="Female" variant={sex === "female" ? "primary" : "secondary"} onPress={() => setSex("female")} /></View>
      </View>
      <TextInput accessibilityLabel="Birth year" style={inputStyle} placeholder="Birth year (e.g. 1995)" placeholderTextColor={colors.mutedForeground} keyboardType="number-pad" value={birthYear} onChangeText={setBirthYear} />
      <TextInput accessibilityLabel="Height in centimetres" style={inputStyle} placeholder="Height (cm)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={heightCm} onChangeText={setHeightCm} />
      <TextInput accessibilityLabel="Weight in kilograms" style={inputStyle} placeholder="Weight (kg)" placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={weightKg} onChangeText={setWeightKg} />

      <Overline style={{ marginTop: 8 }}>Activity</Overline>
      <View style={{ gap: spacing.sm }}>
        {ACTIVITIES.map((a) => (
          <Button key={a} title={a.replace("_", " ")} variant={activity === a ? "primary" : "secondary"} onPress={() => setActivity(a)} />
        ))}
      </View>

      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={submit.isPending ? "Saving…" : "Get started"} onPress={onSubmit} disabled={submit.isPending} />
    </ScrollView>
  );
}
```

- [ ] **Step 4: Run the Onboarding test + full validate test, verify green**

Run: `cd apps/mobile && npm test -- onboarding.test validateOnboarding.test`
Expected: PASS.

- [ ] **Step 5: idb screenshot review vs `Onboarding.jsx`**

Sign in as a fresh/not-onboarded user (or temporarily route to `/onboarding`), screenshot to `scratchpad/onboarding.png`, Read it. Verify: Kora brand lockup, "Snap it. / Otto tracks it." 32px hero, subtitle, "What's your goal?" overline + 3 goal cards with icon chip + radio check, Get started CTA. Fix before accepting.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/onboarding.tsx apps/mobile/app/__tests__/onboarding.test.tsx
git commit -m "feat(mobile): editorial onboarding — brand hero + goal cards"
```

---

## Task 12: Log screen (editorial restyle)

**Read first:** `design-system/ui_kits/kora/MealDetail.jsx` (for the selected-food detail styling) — the capture/hero routes here; the dark Otto CaptureScreen is deferred to Phase 3.

**Files:**
- Replace: `apps/mobile/app/log.tsx`
- Create: `apps/mobile/app/__tests__/log.test.tsx`

**Interfaces:**
- Consumes: `useFoodSearch`, `useCreateLog` (existing), `FoodTile`, `ScreenHeader`, `AppText`, `Numeral`, `Overline`, `Button`, `ProvenanceChip`, `foodVisual`, `tileFaint`, `MACRO`, `useTheme`.
- Search results render as FoodTile rows; selecting one shows an editorial detail (FoodTile + name + macro tiles from the food's per-100g values scaled to the entered grams) with a meal-slot selector and a Log button. Preserves the existing `client_log_ms` time-to-log instrumentation.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/log.test.tsx`:
```tsx
import { render } from "@testing-library/react-native";

jest.mock("expo-router", () => ({ router: { replace: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useFoodSearch: () => ({ data: [{ id: "f1", name: "Grilled chicken breast", brand: "", provenance: "seed", serving_desc: "1 breast", serving_grams: 140, kcal_per_100g: 165, protein_per_100g: 31, carbs_per_100g: 0, fat_per_100g: 3.6 }], isLoading: false }),
  useCreateLog: () => ({ mutate: jest.fn(), isPending: false }),
}));

import LogScreen from "../log";

test("Log screen shows the editorial header and a food tile result", async () => {
  const { findByText } = render(<LogScreen />);
  expect(await findByText("Log food")).toBeTruthy();
  expect(await findByText("Grilled chicken breast")).toBeTruthy();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/mobile && npm test -- log.test`
Expected: FAIL.

- [ ] **Step 3: Implement `app/log.tsx`**

```tsx
import { useRef, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FoodTile } from "@/components/FoodTile";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useCreateLog, useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export default function LogScreen() {
  const { colors, spacing, radius, fonts } = useTheme();
  const mountedAt = useRef(Date.now());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState("");
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const [error, setError] = useState<string | null>(null);
  const search = useFoodSearch(q);
  const createLog = useCreateLog();

  const inputStyle = { borderWidth: 1, borderColor: colors.input, borderRadius: radius.lg, padding: spacing.md, color: colors.foreground, minHeight: 48 } as const;

  function submit() {
    if (!selected) return;
    createLog.mutate(
      { food_item_id: selected.id, meal_slot: meal, source: "manual", quantity_grams: Number(grams) || selected.serving_grams || 100, logged_at: new Date().toISOString(), client_log_ms: Date.now() - mountedAt.current },
      { onSuccess: () => router.replace("/"), onError: () => setError("Couldn't log that. Please try again.") },
    );
  }

  if (selected) {
    const g = Number(grams) || selected.serving_grams || 100;
    const scale = g / 100;
    const macros: ReadonlyArray<readonly [string, string, number]> = [
      ["Protein", `${Math.round(selected.protein_per_100g * scale)}g`, MACRO.protein.hue],
      ["Carbs", `${Math.round(selected.carbs_per_100g * scale)}g`, MACRO.carbs.hue],
      ["Fat", `${Math.round(selected.fat_per_100g * scale)}g`, MACRO.fat.hue],
    ];
    const vis = foodVisual(selected.name, meal);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 20, fontWeight: "800", letterSpacing: -0.5 }}>{selected.name}</AppText>
            <ProvenanceChip provenance={selected.provenance} />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          {macros.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{value}</Numeral>
            </View>
          ))}
        </View>

        <TextInput accessibilityLabel="Quantity in grams" style={inputStyle} placeholder={`Grams (default ${selected.serving_grams || 100})`} placeholderTextColor={colors.mutedForeground} keyboardType="decimal-pad" value={grams} onChangeText={setGrams} />
        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {MEALS.map((m) => (
            <Button key={m} title={m} variant={meal === m ? "primary" : "secondary"} onPress={() => setMeal(m)} />
          ))}
        </View>
        {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
        <Button title={createLog.isPending ? "Logging…" : "Log it"} onPress={submit} disabled={createLog.isPending} />
        <Button title="Back" variant="ghost" onPress={() => setSelected(null)} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: 8 }}>
      <ScreenHeader overline="Add to diary" title="Log food" />
      <View style={{ paddingHorizontal: 20, gap: spacing.md, flex: 1 }}>
        <TextInput accessibilityLabel="Search foods" style={inputStyle} placeholder="Search foods…" placeholderTextColor={colors.mutedForeground} autoFocus value={q} onChangeText={setQ} />
        <FlatList
          data={search.data ?? []}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          renderItem={({ item }) => {
            const vis = foodVisual(item.name);
            return (
              <Pressable accessibilityRole="button" onPress={() => setSelected(item)} style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
                <FoodTile hue={vis.hue} icon={vis.icon} size={48} />
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{item.name}</AppText>
                  <AppText muted style={{ fontSize: 12, fontFamily: fonts.mono }}>{Math.round(item.kcal_per_100g)} kcal/100g · {item.serving_desc}</AppText>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={q.length >= 2 && !search.isLoading ? <AppText muted>No matches.</AppText> : null}
        />
      </View>
    </View>
  );
}
```

- [ ] **Step 4: Run the Log test, verify it passes**

Run: `cd apps/mobile && npm test -- log.test`
Expected: PASS.

- [ ] **Step 5: idb screenshot review**

From Home, tap the capture hero (or the center tab button) to reach `/log`; screenshot to `scratchpad/log.png` and Read it. Verify search results are FoodTile rows and the selected-food detail shows the FoodTile + macro tiles + meal selector, all on-brand. Fix before accepting.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/log.tsx apps/mobile/app/__tests__/log.test.tsx
git commit -m "feat(mobile): editorial log screen — food tiles + macro detail"
```

---

## Task 13: Cleanup, full suite, and dead-widget removal

**Files:**
- Delete: `apps/mobile/src/components/Ring.tsx` (replaced by `CircularProgress`), `apps/mobile/src/components/MacroBar.tsx` (no longer used) — **only if** no remaining import references them.
- Delete their tests within `apps/mobile/src/components/__tests__/dashboard-widgets.test.tsx` if it solely tested Ring/MacroBar; otherwise trim those cases.

- [ ] **Step 1: Find remaining references**

```bash
cd apps/mobile
grep -rn "components/Ring\|components/MacroBar\|from \"@/components/Ring\"\|from \"@/components/MacroBar\"" src app
```
Expected: no matches outside the files/tests being deleted. If Home or elsewhere still imports them, that's a bug — fix the screen first.

- [ ] **Step 2: Remove dead widgets + tests**

```bash
git rm apps/mobile/src/components/Ring.tsx apps/mobile/src/components/MacroBar.tsx
```
Edit `apps/mobile/src/components/__tests__/dashboard-widgets.test.tsx`: remove Ring/MacroBar cases (or `git rm` the file if it only covered those two). Keep any still-relevant primitive tests.

- [ ] **Step 3: Run the full suite foreground**

Run: `cd apps/mobile && npm test`
Expected: PASS (all green).

- [ ] **Step 4: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors. Fix any type issues (e.g. `radius["2xl"]` indexing, `BottomTabBarProps` import).

- [ ] **Step 5: Final full-app idb walkthrough (fidelity gate)**

With API + Metro up and the demo user signed in, screenshot each surface (`home.png`, `diary.png`, `progress.png`, `log.png`, `meal.png`, `onboarding.png`) and Read each alongside its mockup. Confirm every screen passes the §5 gate. Note any residual gaps.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(mobile): remove flat Ring/MacroBar widgets superseded by fidelity pass"
```

---

## Self-Review (spec §5 coverage)

- **Home = Otto-led feed, not a dashboard** → Task 8 (headline + hero + FuelStrip secondary + feed). ✓
- **Real circular ring via react-native-svg** → Task 2 + used in FuelStrip. ✓
- **FoodTile** → Task 3, used on Home/Diary/Log/Meal. ✓
- **Floating TabBar with center capture** → Task 7. ✓
- **ScreenHeader / Sheet / Avatar** → Tasks 4/5/6/7. ✓
- **Editorial type (overline, 28/27px titles, mono numerals, accent kcal)** → Tasks 1/4, applied per screen. ✓
- **Diary week strip + timeline** → Task 9. ✓
- **Progress weight chart + stat grid** → Task 10. ✓
- **Onboarding brand hero + goal cards** → Task 11. ✓
- **Log restyle (capture routes here)** → Task 12. ✓
- **Placeholders that match shape** (Otto copy, camera/voice/AI capture, weight tracking) → static copy on Home, capture→/log, static weight series on Progress, all flagged. ✓
- **Per-screen idb review before merge** → review step in Tasks 7–12 + final walkthrough Task 13. ✓
- **RN can't render oklch** → `hue.ts` HSL helpers (Task 3), enforced in Global Constraints. ✓

## Running services (for idb review steps)

- **Postgres/Redis:** `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora && docker compose up -d` (if not already up).
- **API:** `cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable' FIREBASE_PROJECT_ID='kora-app-e6d38' go run ./cmd/api` (run `go run ./cmd/migrate` + `go run ./cmd/seed` first if the DB is fresh).
- **Metro:** `cd apps/mobile && npx expo start --ios --port <free>`; if the app doesn't auto-open: `xcrun simctl openurl booted exp://127.0.0.1:<port>`.
- **Sim / idb:** booted UDID `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`; idb at `~/Library/Python/3.9/bin/idb` (+ homebrew `idb_companion`). Demo account `demo@kora.app` / `KoraDemo123!` (already onboarded).
