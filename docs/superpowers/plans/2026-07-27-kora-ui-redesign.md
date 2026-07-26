# Kora iOS-Native UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign every mobile screen to iOS-native Apple HIG (spec: `docs/superpowers/specs/2026-07-27-kora-ui-redesign-design.md`) — grouped surfaces, SF type scale, green accent, spring motion, haptics, light+dark — with zero API/data changes.

**Architecture:** Rewrite `src/theme/` as hand-authored iOS semantic tokens keeping legacy key names as aliases so all call sites keep compiling; add a `src/motion/` kit (springs, PressableScale, AnimatedNumber, haptics, reduced-motion); restyle components in place preserving props/testIDs/a11y labels; then rebuild screens phase by phase.

**Tech Stack:** Expo SDK 57, react-native-reanimated 4.5, react-native-gesture-handler 2.32, expo-blur, expo-haptics (new), expo-symbols (new), jest + RNTL v14 (async render), TypeScript.

## Global Constraints

- Branch: `ui-redesign` off `main`. Working dir for all commands: `apps/mobile`.
- Verify per task: `npx tsc --noEmit` then `npm test -- --ci` — run **foreground**, never background.
- RNTL v14: `render`/`fireEvent` are async — always `await render(...)`, `await fireEvent...`.
- Preserve every existing `testID`, `accessibilityRole`, `accessibilityLabel`, and behavior (navigation params, mutation payloads, validation gates) unless a step explicitly changes it. When a test must change, the step says which file and what the new assertion is — never weaken coverage.
- No `any`, no `console.log`, no oklch, no hex colors in screens (theme tokens only; the token files themselves hold the hex).
- Colors exactly as specced: accent `#34C759`/`#30D158`; amber `#FF9500`/`#FF9F0A`; blue `#007AFF`/`#0A84FF`; destructive `#FF3B30`/`#FF453A`; canvas `#F2F2F7`/`#000000`; card `#FFFFFF`/`#1C1C1E`.
- Springs: `standard` (dampingRatio 1) for appearing/updating UI; `lively` (dampingRatio 0.8) only for gesture-released motion. Reduced motion (OS setting) swaps springs → fades/snaps; haptics remain.
- Haptics only on causal frames: selection (tab/segment/week-strip), impactLight (primary buttons), success (log written), error (mutation failed).
- Single-line conventional commits, no signatures. Stage explicit paths, never `git add -A`.
- No backend or `src/api/` changes of any kind.

---

## Phase 1 — Foundation

### Task 1: Theme rewrite (palette + type scale + AppText)

**Files:**
- Create: `src/theme/palette.ts`
- Delete: `src/theme/tokens.ts` (generated web tokens — mobile stops consuming them)
- Modify: `src/theme/index.ts`, `src/components/Text.tsx`
- Test: `src/theme/__tests__/` (update existing), `src/components/__tests__/text.test.tsx` (update if variant presets asserted)

**Interfaces:**
- Produces: `useTheme()` returning `{ colors, spacing, radius, fontSize, fonts, shadows, scheme, type }`. `colors` keeps ALL legacy keys (`background`, `foreground`, `card`, `cardForeground`, `primary`, `primaryForeground`, `secondary`, `secondaryForeground`, `muted`, `mutedForeground`, `accent`, `accentForeground`, `destructive`, `destructiveForeground`, `border`, `input`, `ring`, `success`, `warning`, `error`, `info`) plus NEW keys `label`, `secondaryLabel`, `tertiaryLabel`, `cardSecondary`, `separator`, `accentAmber`, `accentBlue`. `type` is the preset record below. `AppText` gains variants `largeTitle | title1 | title2 | headline | body | subheadline | footnote | caption` (legacy `h1|h2|h3` remain as aliases).

- [ ] **Step 1: Write `src/theme/palette.ts`** (hand-authored, replaces generated tokens):

```ts
// Hand-authored iOS-native palette. Light/dark pairs. Do NOT regenerate from design-system.
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
} as const;

export const darkColors: Record<keyof typeof lightColors, string> = {
  ...shared,
  background: "#000000",
  foreground: "#FFFFFF",
  label: "#FFFFFF",
  secondaryLabel: "rgba(235,235,245,0.60)",
  tertiaryLabel: "rgba(235,235,245,0.30)",
  card: "#1C1C1E",
  cardForeground: "#FFFFFF",
  cardSecondary: "#2C2C2E",
  primary: "#30D158",
  primaryForeground: "#000000",
  secondary: "#2C2C2E",
  secondaryForeground: "#FFFFFF",
  muted: "#2C2C2E",
  mutedForeground: "rgba(235,235,245,0.60)",
  accent: "#30D158",
  accentForeground: "#000000",
  accentAmber: "#FF9F0A",
  accentBlue: "#0A84FF",
  destructive: "#FF453A",
  border: "rgba(84,84,88,0.60)",
  separator: "rgba(84,84,88,0.60)",
  input: "#2C2C2E",
  ring: "#30D158",
  success: "#30D158",
  warning: "#FF9F0A",
  error: "#FF453A",
  info: "#0A84FF",
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
```

- [ ] **Step 2: Update `src/theme/index.ts`** — import from `./palette` instead of `./tokens`; export `type` in the returned theme object; add `fonts.rounded = Platform.select({ ios: "ui-rounded", default: undefined })` alongside existing `fonts.mono`; keep `makeShadows` but soften: sm `shadowOpacity 0.05/radius 8`, md `0.08/16`, lg `0.12/24` (shadowColor `#000000` both schemes). Delete `src/theme/tokens.ts`.

- [ ] **Step 3: Update `src/components/Text.tsx`** — presets become the `type` scale; legacy aliases map `h1→largeTitle`, `h2→title1`, `h3→title2`, old `caption→footnote`; `muted` uses `colors.secondaryLabel`. Add optional `rounded?: boolean` prop → `fontFamily: fonts.rounded` when set.

```tsx
import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";
import { type as typeScale, type TypeVariant } from "@/theme/palette";

type LegacyVariant = "h1" | "h2" | "h3";
type Variant = TypeVariant | LegacyVariant | "caption";
const legacy: Record<LegacyVariant, TypeVariant> = { h1: "largeTitle", h2: "title1", h3: "title2" };

interface Props extends TextProps { variant?: Variant; muted?: boolean; rounded?: boolean }

export function AppText({ variant = "body", muted = false, rounded = false, style, ...rest }: Props) {
  const { colors, fonts } = useTheme();
  const key: TypeVariant =
    variant in legacy ? legacy[variant as LegacyVariant] : (variant as TypeVariant);
  const p = typeScale[key] ?? typeScale.body;
  return (
    <Text
      style={[
        { fontSize: p.size, fontWeight: p.weight, letterSpacing: p.letterSpacing, lineHeight: p.lineHeight,
          color: muted ? colors.secondaryLabel : colors.label,
          ...(rounded && fonts.rounded ? { fontFamily: fonts.rounded } : null) },
        style,
      ]}
      {...rest}
    />
  );
}
```

Note: old `caption` (12/400) call sites now render footnote 13/400 — acceptable per spec; new `caption` (11/500/+0.5) is for grouped-section headers.

- [ ] **Step 4: Fix compile fallout** — `npx tsc --noEmit`; any file importing `@/theme/tokens` directly gets re-pointed to `@/theme/palette` (grep `from "@/theme/tokens"` / `"../tokens"`). Update `src/theme/__tests__/` to import from `palette` and assert: `darkColors` has every `lightColors` key; `primary === "#34C759"` light / `"#30D158"` dark; `background === "#F2F2F7"`/`"#000000"`.

- [ ] **Step 5: Run `npx tsc --noEmit` && `npm test -- --ci`** — fix any test asserting old purple/values by updating expected values to the new palette (do not delete assertions).

- [ ] **Step 6: Commit** — `feat(ui): iOS-native palette + SF type scale, retire generated web tokens`

### Task 2: Motion kit + haptics dep

**Files:**
- Create: `src/motion/springs.ts`, `src/motion/haptics.ts`, `src/motion/useMotionPrefs.ts`, `src/motion/PressableScale.tsx`, `src/motion/AnimatedNumber.tsx`, `src/motion/index.ts`
- Modify: `package.json` (via `npx expo install expo-haptics`), `jest.setup.js`
- Test: `src/motion/__tests__/motion.test.tsx`

**Interfaces:**
- Produces: `springs.instant|standard|lively` (Reanimated `WithSpringConfig`s); `haptics.selection()|impactLight()|success()|error()`; `useMotionPrefs(): { reduceMotion: boolean }`; `<PressableScale haptic?="selection|impactLight|success|error|none" scaleTo?=0.96 {...PressableProps}>` (node children only); `<AnimatedNumber value format? style? duration?=600>`.

- [ ] **Step 1: `npx expo install expo-haptics`**

- [ ] **Step 2: jest mocks** — in `jest.setup.js` add:

```js
jest.mock("expo-haptics", () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));
```

Also ensure Reanimated test setup is active (Reanimated 4 ships its mock via the babel/jest preset in jest-expo; if `useReducedMotion` errors in tests, add `jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"))` — prefer the preset if it works).

- [ ] **Step 3: Write the kit.** `springs.ts`:

```ts
import type { WithSpringConfig } from "react-native-reanimated";

// Apple-derived: dampingRatio 1.0 = critically damped; response ≈ duration.
export const springs = {
  instant: { duration: 150, dampingRatio: 1 },
  standard: { duration: 350, dampingRatio: 1 },
  lively: { duration: 400, dampingRatio: 0.8 }, // gesture-released motion only
} as const satisfies Record<string, WithSpringConfig>;
```

`haptics.ts`:

```ts
import * as Haptics from "expo-haptics";

function safe(run: () => Promise<void>): void {
  run().catch(() => {}); // haptics are best-effort; never throw into UI
}

export const haptics = {
  selection: (): void => safe(() => Haptics.selectionAsync()),
  impactLight: (): void => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: (): void => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: (): void => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
} as const;
```

`useMotionPrefs.ts`:

```ts
import { useReducedMotion } from "react-native-reanimated";

export function useMotionPrefs(): { reduceMotion: boolean } {
  return { reduceMotion: useReducedMotion() } as const;
}
```

`PressableScale.tsx` (inner Animated.View so any caller style shape works):

```tsx
import type { ReactNode } from "react";
import { Pressable, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { springs } from "./springs";
import { haptics } from "./haptics";
import { useMotionPrefs } from "./useMotionPrefs";

type HapticKind = keyof typeof haptics | "none";

interface Props extends Omit<PressableProps, "children"> {
  children: ReactNode;
  haptic?: HapticKind;
  scaleTo?: number;
}

export function PressableScale({ children, haptic = "none", scaleTo = 0.96, onPressIn, onPressOut, onPress, ...rest }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => { if (!reduceMotion) scale.value = withSpring(scaleTo, springs.instant); onPressIn?.(e); }}
      onPressOut={(e) => { scale.value = withSpring(1, springs.standard); onPressOut?.(e); }}
      onPress={(e) => { if (haptic !== "none") haptics[haptic](); onPress?.(e); }}
    >
      <Animated.View style={animated}>{children}</Animated.View>
    </Pressable>
  );
}
```

`AnimatedNumber.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { cancelAnimation, Easing, runOnJS, useAnimatedReaction, useSharedValue, withTiming } from "react-native-reanimated";
import { useMotionPrefs } from "./useMotionPrefs";

interface Props {
  value: number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
  duration?: number;
}

const defaultFormat = (n: number): string => Math.round(n).toLocaleString();

export function AnimatedNumber({ value, format = defaultFormat, style, duration = 600 }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const sv = useSharedValue(value);
  const prev = useRef(value);
  const [display, setDisplay] = useState(() => format(value));

  useEffect(() => {
    if (reduceMotion) { cancelAnimation(sv); prev.current = value; setDisplay(format(value)); return; }
    sv.value = prev.current;                         // animate from current presentation, never zero
    prev.current = value;
    sv.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
  }, [value, reduceMotion]);                          // eslint-disable-line react-hooks/exhaustive-deps

  useAnimatedReaction(
    () => sv.value,
    (v) => { runOnJS(setDisplay)(format(v)); },
    [format],
  );

  return <Text style={[{ fontVariant: ["tabular-nums"] }, style]}>{display}</Text>;
}
```

`index.ts` re-exports all five modules.

- [ ] **Step 4: Tests** (`src/motion/__tests__/motion.test.tsx`): (a) `PressableScale` fires `onPress` and the mapped haptic (`selectionAsync` called when `haptic="selection"`); (b) `PressableScale` with `haptic="none"` calls no haptics; (c) `AnimatedNumber` renders the formatted target (use fake timers, `jest.advanceTimersByTime(1000)` inside `act`, assert final text; if the reanimated mock settles synchronously, the assert works without timers — keep whichever is green); (d) `haptics.success` swallows a rejected promise (mock `notificationAsync` to reject once — no unhandled rejection).

- [ ] **Step 5: `npx tsc --noEmit` && `npm test -- --ci`** → green.

- [ ] **Step 6: Commit** — `feat(ui): motion kit (springs, PressableScale, AnimatedNumber, haptics, reduced-motion)`

### Task 3: SF Symbols icons

**Files:**
- Modify: `src/components/Icon.tsx`, `jest.setup.js`, `package.json` (via `npx expo install expo-symbols`)
- Test: `src/components/__tests__/` (icon test if present; otherwise add `icon.test.tsx`)

**Interfaces:**
- Produces: `Icon` keeps exact API `{ name, size?, color, strokeWidth? }`. Names resolve SF-Symbol-first, lucide fallback, `Circle` last. New names available to later tasks: `"chevron-right"`, `"droplet"`, `"person"`, `"gear"`, `"flame"`.

- [ ] **Step 1: `npx expo install expo-symbols`**; jest mock in `jest.setup.js`:

```js
jest.mock("expo-symbols", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { SymbolView: (props) => React.createElement(View, { testID: `sf-${props.name}` }) };
});
```

- [ ] **Step 2: Rewrite `Icon.tsx`** — add SF map, keep lucide fallback, REMOVE `Sparkles` (grep `"sparkles"` call sites first; if any survive outside files this plan deletes later, replace with `"camera"`):

```tsx
import { SymbolView, type SFSymbol } from "expo-symbols";
// keep existing lucide imports minus Sparkles

const SYMBOLS: Record<string, SFSymbol> = {
  house: "house.fill", "book-open": "book.fill", camera: "camera.fill",
  "chart-line": "chart.line.uptrend.xyaxis", "grid-2x2": "square.grid.2x2.fill",
  "message-circle": "message.fill", mic: "mic.fill", plus: "plus",
  utensils: "fork.knife", "trending-down": "arrow.down.right", "trending-up": "arrow.up.right",
  minus: "minus", check: "checkmark", "arrow-right": "arrow.right", "arrow-left": "chevron.left",
  "trash-2": "trash.fill", x: "xmark", images: "photo.on.rectangle",
  "scan-barcode": "barcode.viewfinder", type: "character.cursor.ibeam", barcode: "barcode",
  "arrow-up": "arrow.up", repeat: "arrow.clockwise", users: "person.2.fill", bell: "bell.fill",
  "chevron-right": "chevron.right", droplet: "drop.fill", person: "person.crop.circle.fill",
  gear: "gearshape.fill", flame: "flame.fill",
};

export function Icon({ name, size = 20, color, strokeWidth = 2 }: Props) {
  const sf = SYMBOLS[name];
  if (sf) return <SymbolView name={sf} size={size} tintColor={color} />;
  const Cmp = MAP[name] ?? Circle;
  return <Cmp size={size} color={color} strokeWidth={strokeWidth} />;
}
```

- [ ] **Step 3: Test** — `Icon name="house"` renders testID `sf-house.fill`; unknown name still renders (fallback); a lucide-only name (e.g. `leaf`) renders without SymbolView.

- [ ] **Step 4: `npx tsc --noEmit` && `npm test -- --ci`** — existing component tests that queried lucide output for symbol-mapped names may need the `sf-` testID instead; update those assertions only.

- [ ] **Step 5: Commit** — `feat(ui): SF Symbols icon path with lucide fallback, drop sparkles`

### Task 4: Sheet v2 (spring + grabber + drag-to-dismiss)

**Files:**
- Modify: `src/components/Sheet.tsx`
- Test: `src/components/__tests__/sheet.test.tsx` (create/extend)

**Interfaces:**
- Produces: same API `{ visible, onClose, children }` — all 8+ existing sheet call sites must work unchanged.

- [ ] **Step 1: Rewrite `Sheet.tsx`:**

```tsx
import { type ReactNode, useEffect } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { springs } from "@/motion/springs";
import { useMotionPrefs } from "@/motion/useMotionPrefs";
import { useTheme } from "@/theme";

interface Props { visible: boolean; onClose: () => void; children: ReactNode }

export function Sheet({ visible, onClose, children }: Props) {
  const { colors, radius } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const { height: screenH } = useWindowDimensions();
  const translateY = useSharedValue(screenH);

  useEffect(() => {
    if (visible) translateY.value = reduceMotion ? 0 : withSpring(0, springs.standard);
  }, [visible, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = () => {
    if (reduceMotion) { onClose(); return; }
    translateY.value = withSpring(screenH, springs.lively, (done) => { if (done) runOnJS(onClose)(); });
  };

  const pan = Gesture.Pan()
    .onChange((e) => {
      const next = translateY.value + e.changeY;
      // rubber-band above rest position
      translateY.value = next >= 0 ? next : next / 3;
    })
    .onEnd((e) => {
      const shouldClose = e.velocityY > 500 || (translateY.value > 120 && e.velocityY > -200);
      if (shouldClose) {
        translateY.value = withSpring(screenH, { ...springs.lively, velocity: e.velocityY }, (done) => { if (done) runOnJS(onClose)(); });
      } else {
        translateY.value = withSpring(0, { ...springs.standard, velocity: e.velocityY });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, screenH], [1, 0]),
  }));

  if (!visible) return null;
  return (
    <Modal visible transparent animationType={reduceMotion ? "fade" : "none"} onRequestClose={dismiss}>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Animated.View style={[{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.4)" }, scrimStyle]}>
          <Pressable accessibilityLabel="Close" onPress={dismiss} style={{ flex: 1 }} />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              { maxHeight: "82%", backgroundColor: colors.card, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"] },
              sheetStyle,
            ]}
          >
            <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 5, borderRadius: 999, backgroundColor: colors.tertiaryLabel }} />
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}
```

Note the surface is now `colors.card` (was `background`) — correct for grouped style; nested inputs inside sheets use `cardSecondary`.

- [ ] **Step 2: Tests** — (a) renders children when `visible`; (b) renders nothing when `!visible`; (c) scrim press (label "Close") calls `onClose` (with reduced-motion mocked true so dismissal is synchronous: `jest.mock("@/motion/useMotionPrefs", () => ({ useMotionPrefs: () => ({ reduceMotion: true }) }))` inside this test file). Gesture-handler in jest: ensure `react-native-gesture-handler/jestSetup` is registered in `jest.setup.js` (add if missing).

- [ ] **Step 3: Run existing sheet-consumer tests** (`meal`, `WeightLogSheet`, `AddFriendSheet`, `CreateGroupSheet`, `CreateChallengeSheet`, `CopyDaySheet`, `RenameGroupSheet`, `InviteFriendSheet`) — all must stay green; if a test tapped the old scrim by structure, re-target the "Close" label.

- [ ] **Step 4: `npx tsc --noEmit` && `npm test -- --ci`**, **Commit** — `feat(ui): Sheet v2 with spring presentation, grabber, drag-to-dismiss`

### Task 5: Primitives restyle (Button, Card, GroupedList, Segmented, CircularProgress, Overline, Numeral, Stat, Badge, Avatar, ScreenHeader, Stepper)

**Files:**
- Create: `src/components/GroupedList.tsx`, `src/components/Segmented.tsx`
- Modify: `src/components/{Button,Card,Overline,Numeral,Stat,Badge,Avatar,ScreenHeader,CircularProgress,Stepper}.tsx`
- Test: existing component tests + `src/components/__tests__/{grouped-list,segmented}.test.tsx`

**Interfaces:**
- Produces:
  - `GroupedSection({ header?, footer?, children, style? })` — caption header (uppercase, secondaryLabel, 16 left margin), white/dark card radius 12 `overflow:hidden`, hairline separators auto-inserted between children (left-inset 16), optional footnote footer.
  - `Row({ title, subtitle?, detail?, icon?: { name: string; tint: string }, chevron?, destructive?, onPress?, right?, accessibilityLabel? })` — min height 44, 16 horizontal padding, tinted 29×29 squircle (radius 6.5) icon container with white symbol, title Headline (destructive → `colors.destructive`), subtitle Footnote muted, `detail` right-aligned Subheadline secondaryLabel + `tabular-nums`, chevron `chevron-right` tertiaryLabel size 14. Uses `PressableScale` when `onPress` given (default haptic "none"), plain `View` otherwise.
  - `Segmented({ options: Array<{ key: string; label: string }>, value, onChange })` — iOS segmented control: track `cardSecondary` radius 9, selected segment white/dark-elevated pill (radius 7, shadow sm), spring slide between segments, `haptics.selection()` on change, `accessibilityRole="tab"` per segment.
- `Button` variants: `primary` (accent bg, white text, radius 12, height 50, PressableScale + impactLight), `secondary` (`cardSecondary` bg, label text), `ghost` (transparent, accent text), `destructive` (NEW: transparent, destructive text — for sheet remove-actions). Title style: Headline. Existing `title/variant/disabled` props unchanged.
  - `Card`: **borderless** — `backgroundColor colors.card`, radius 12, padding 16, no borderWidth, no shadow by default.
  - `CircularProgress`: same props, but arc animates `strokeDashoffset` from previous → new value with `withSpring(springs.standard)` (Animated.createAnimatedComponent(Path/Circle), `useAnimatedProps`); reduced motion → jump. Keep testIDs `cp-arc` semantics (dasharray/dashoffset assertions in the existing test must still pass in the reduced-motion/jest path — set initial offset to the final value when `reduceMotion`).
  - `Overline`: renders AppText `caption` uppercase secondaryLabel (kept for legacy call sites; new code prefers `GroupedSection header`).
  - `Numeral`: SF Rounded (`rounded` prop of AppText) + `tabular-nums`, weight 700.
  - `Stat`: value uses Numeral style (rounded, 22), label Footnote muted — no bordered box (bare, for use inside Card/GroupedSection).
  - `Badge`: capsule, tinted background at 15% opacity of its color, colored Footnote text (e.g. success badge: `rgba(52,199,89,0.15)` bg via token + success text). No hardcoded hsl.
  - `Avatar`: unchanged API; background `cardSecondary`, initials Headline label.
  - `ScreenHeader`: title becomes LargeTitle (34/700/−0.4), overline slot renders Subheadline muted **below**-style date/subtitle (keep both props: `overline` renders as the small line above in caption-uppercase only if provided); back button = `chevron.left` in a `PressableScale` 36×36, keep `onBack` prop + a11y label.
  - `Stepper`: iOS capsule — one `cardSecondary` capsule containing − / value / + with hairline dividers; **press-and-hold repeat** (interval 120ms after 400ms delay, cleared on pressOut/unmount); same props `{ value, onChange, step?, min? }`; keep "Increase"/"Decrease" a11y labels; `haptics.selection()` per tick.

- [ ] **Step 1: Write failing tests first** for the two new components: GroupedList (header text renders uppercase; N children → N−1 separators via testID `row-sep`; Row onPress fires; `detail` text renders) and Segmented (renders all labels; press fires `onChange` with key + `selectionAsync` called; selected segment has `accessibilityState.selected`).
- [ ] **Step 2: Run — expect FAIL (components don't exist).**
- [ ] **Step 3: Implement all components listed above.** Keep every existing prop name. For `CircularProgress`, read the existing test before editing; preserve its `cp-arc` contract exactly as described.
- [ ] **Step 4: Fix fallout in existing component tests** — expected: Button pressed-state opacity assertions (now scale-based: assert `onPress` still fires instead), Card border assertions (assert no border / bg color token), Badge hsl assertion (assert token-derived color). Update values, never delete cases.
- [ ] **Step 5: `npx tsc --noEmit` && `npm test -- --ci`**, **Commit** — `feat(ui): iOS primitives — grouped lists, segmented control, borderless cards, animated ring, capsule stepper`

### Task 6: Floating tab bar refresh

**Files:**
- Modify: `src/components/FloatingTabBar.tsx`
- Test: `src/components/__tests__/FloatingTabBar.test.tsx`

**Interfaces:**
- Consumes: `springs`, `haptics`, `PressableScale`, SF-symbol `Icon`.
- Produces: same component contract with the (tabs) layout; capture center button role/route unchanged (`/capture`).

- [ ] **Step 1:** Restyle: BlurView pill stays; active tint `colors.primary`, inactive `colors.secondaryLabel`; icons via SF symbols (house/book/chart-line/grid-2x2 already mapped); active tab icon scales in with `withSpring(springs.standard)` (1 → 1.0 selected emphasis + small dot under active icon in accent); every tab press = `haptics.selection()`; capture button = accent circle 54×54 with white camera symbol, `PressableScale haptic="impactLight"`, same route push. Unread badge on More: keep exact behavior (`count>0`), restyle to accent dot.
- [ ] **Step 2:** Update FloatingTabBar.test only if structure queries break; keep the unread-badge and route assertions intact.
- [ ] **Step 3:** `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): tab bar — SF symbols, green tint, selection springs + haptics`

**Controller checkpoint after Phase 1:** run `npx expo prebuild --platform ios` (validates expo-haptics/expo-symbols config) and rebuild the dev client (`npm run ios`) before Phase 2 live checks.

---

## Phase 2 — Core loop screens

Shared rules for every screen task: screens read tokens only (no hex); lists use `GroupedSection`/`Row`; entrances = Reanimated `entering={FadeInDown.duration(300).delay(i * 30)}` on first mount only (guard with a `useRef` mounted flag so refetches don't re-stagger); every tappable is `PressableScale`; screen padding 16; all data hooks, params, and mutation payloads byte-identical to current.

### Task 7: Home

**Files:**
- Modify: `app/(tabs)/index.tsx`
- Create: `src/components/home/KcalHero.tsx`, `src/components/home/MacroBars.tsx`
- Delete: `src/components/home/CaptureHero.tsx`, `src/components/home/FeedMeal.tsx`, `src/components/home/FuelStrip.tsx`
- Test: `app/(tabs)/__tests__/index.test.tsx` (rewrite assertions)

**Interfaces:**
- Consumes: `useProfile`, `useDashboard(date)`, `useDayLogs(date)` — unchanged; `openMeal(log)` params object stays byte-identical.
- Produces: `KcalHero({ left, goal, eaten })` — AnimatedNumber SF-Rounded 52/700 kcal-left + `CircularProgress` (eaten/goal) side by side + "calories left" Footnote muted; skeleton state via `loading?: boolean` (renders `—` placeholder, no 0-flash). `MacroBars({ macros })` — same macros shape FuelStrip took `{ p, c, f, pGoal, cGoal, fGoal }`; three horizontal bars green/amber/blue with `Xg / Yg` Footnote labels; bar fill animates withSpring standard.

- [ ] **Step 1:** New screen structure (keep `today()`, `greeting()`, `dateLabel()`, `initials()`, `openMeal` helpers verbatim; DELETE the `NOTES` array and editorial headline block):

```tsx
<ScrollView …>
  {/* header: large title */}
  <View style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}>
    <View>
      <AppText variant="subheadline" muted>{dateLabel()}</AppText>
      <AppText variant="largeTitle">Today</AppText>
    </View>
    <Avatar initials={initials(profile.data?.display_name)} />
  </View>
  {/* error state keeps current copy + destructive color */}
  {/* hero */}
  <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
    <Card><KcalHero left={left} goal={goal} eaten={eaten} loading={!d && !loadError} />
      {d ? <MacroBars macros={{ p: d.consumed.protein_g, c: d.consumed.carbs_g, f: d.consumed.fat_g, pGoal: d.targets.protein_g, cGoal: d.targets.carbs_g, fGoal: d.targets.fat_g }} /> : null}
    </Card>
  </View>
  {/* meals */}
  <GroupedSection header="Meals" style={{ paddingHorizontal: 16, marginTop: 8 }}>
    {loggedMeals.map((log, i) => (
      <Row key={log.id} title={log.description} subtitle={`${log.meal_slot} · ${time(log)}`} detail={`${Math.round(log.kcal)} kcal`} chevron onPress={() => openMeal(log)} />
    ))}
    <Row title="Log a meal" icon={{ name: "plus", tint: colors.primary }} onPress={() => router.push("/capture")} accessibilityLabel="Add a meal" />
  </GroupedSection>
</ScrollView>
```

The greeting string moves into the date subtitle line: `{dateLabel()} · {greeting()}, {firstName}` — keep the `|| "there"` empty-name guard. Coach button is dropped (was a no-op placeholder).

- [ ] **Step 2:** Rewrite `index.test.tsx`: assert "Today" renders; kcal-left number renders (mock reduced-motion true in jest so AnimatedNumber snaps); meal rows render description + kcal; "Add a meal" a11y label present and routes to `/capture`; error state shows existing error copy. Keep the 3-test structure/coverage.
- [ ] **Step 3:** Delete dead components + their test references; grep `CaptureHero|FeedMeal|FuelStrip` = 0.
- [ ] **Step 4:** `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): Home — large-title Today, animated kcal hero, grouped meal list`

### Task 8: Diary (+ swipe-to-delete)

**Files:**
- Modify: `app/(tabs)/diary.tsx`
- Test: `app/(tabs)/__tests__/diary*.test.tsx`

**Interfaces:**
- Consumes: `useDashboard(selected)`, `useDayLogs(selected)`, `useAddWater`, `useDeleteLog` (already exists in `src/api/hooks`), `CopyDaySheet` (unchanged), `openMeal` params identical to Home.

- [ ] **Step 1:** Restyle: large title "Diary"; week strip → 7 `PressableScale` day cells, selected cell = accent-filled circle with white day number + spring scale-in, `haptics.selection()` on select, today ring-outlined, loggable dot kept; summary `Card` with three `Stat`s (Total/Remaining/Water) using `AnimatedNumber`; timeline → one `GroupedSection` per meal slot present that day (headers "BREAKFAST" etc.), rows as in Home.
- [ ] **Step 2:** Swipe-to-delete: wrap each meal `Row` in `ReanimatedSwipeable` (from `react-native-gesture-handler/ReanimatedSwipeable`) with a right action = destructive red panel + trash symbol; action press runs the SAME confirm-Alert → `useDeleteLog` flow the meal sheet uses (extract that handler if needed, do not change payloads). Test: render a row, fire the right-action press, assert Alert called (mock `Alert.alert`), confirm invokes delete mutation with log id.
- [ ] **Step 3:** Water buttons → green capsules `+250 ml` / `+500 ml` with success haptic on success (existing `logged_at` noon-UTC computation and error surface unchanged). Empty-state Copy-day CTA → grouped Row. Keep conditional `CopyDaySheet` mount.
- [ ] **Step 4:** Update diary tests: week-strip selection still switches data date; water button payload assertions unchanged; new swipe-delete test as above. `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): Diary — grouped slots, springy week strip, swipe-to-delete, capsule water`

### Task 9: Progress

**Files:**
- Modify: `app/(tabs)/progress.tsx`, `src/components/progress/WeightChart.tsx`, `src/components/progress/WeightLogSheet.tsx`
- Test: `app/(tabs)/__tests__/progress.test.tsx`, progress component tests

**Interfaces:**
- Consumes: `useWeightSeries(range)`, `useAddWeight`, `useDashboard` streak — unchanged; WeightChart props unchanged.

- [ ] **Step 1:** Large title "Progress". Weight card: current weight as `AnimatedNumber` SF-Rounded 40/700 + "kg" Subheadline, delta `Badge` (existing neutral-on-gain logic), tap-card→sheet flow intact.
- [ ] **Step 2:** WeightChart: line path animates draw-in via `strokeDasharray/strokeDashoffset` `withTiming` 700ms on data change (reduced motion → static); area fill fades in; axis labels Footnote `tabular-nums`; colors: line `colors.primary`, gradient fill accent at 12% opacity. Keep `>=2 points` guard + all math.
- [ ] **Step 3:** Range toggle 1W/1M/3M/1Y → `Segmented`. Stats grid → 2×2 of `Card`+`Stat`; streak label "day streak" singular/plural kept.
- [ ] **Step 4:** Update tests (segmented labels; existing header/weight/streak assertions re-targeted). `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): Progress — rounded weight hero, chart draw-in, segmented ranges`

### Task 10: Meal detail sheet

**Files:**
- Modify: `app/meal.tsx`
- Test: `app/__tests__/meal.test.tsx`

**Interfaces:**
- Consumes: Sheet v2, `Stepper` (capsule version), `Segmented`, `useEditLog`/`useDeleteLog`/`useRepeatLog` — payload shapes and dirty-gating logic byte-identical.

- [ ] **Step 1:** Restyle inside Sheet v2: title Title2 + slot/time Footnote; macro tiles → three inline `Stat`s in a `Card` (green/amber/blue values); grams `Stepper` capsule; slot picker → `Segmented` (same four slots, same values sent); Save = primary Button (disabled-until-dirty kept); Repeat = secondary Button with `repeat` symbol (Alert flow kept); Remove = `destructive` Button variant (confirm-Alert kept). Success haptic on save/repeat success, error haptic on failure.
- [ ] **Step 2:** meal.test: keep the clean-form-no-PATCH and exact-combined-PATCH-shape assertions untouched (they must pass unmodified — proves payload preservation); re-target only render queries that changed. `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): meal sheet — capsule stepper, segmented slots, iOS actions`

### Task 11: Log-search screen

**Files:**
- Modify: `app/log.tsx`
- Test: `app/__tests__/log.test.tsx`

- [ ] **Step 1:** Restyle: header inline (back chevron + "Log food" Headline); search field = `cardSecondary` filled input with `magnifyingglass` symbol (add `"search": "magnifyingglass"` to Icon SYMBOLS); results → `GroupedSection` of `Row`s (name + brand Footnote + kcal/100g detail, staggered entrance); selected-food detail: `ProvenanceChip` kept as-is functionally but restyled to capsule tinted style; macro preview → three `Stat`s; grams input `cardSecondary` filled; meal selector → `Segmented`; Log button primary with success haptic. `client_log_ms` instrumentation and `createLog.mutate` payload untouched.
- [ ] **Step 2:** Update render queries in log.test only; mutation payload assertions must pass unmodified. `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): log search — grouped results, filled fields, segmented slots`

### Task 12: Capture restyle

**Files:**
- Modify: `app/capture.tsx`, `src/components/capture/{captureTheme.ts,ModePill.tsx,DetectedCard.tsx,OttoBubble.tsx,UserBubble.tsx}`
- Test: existing capture tests

- [ ] **Step 1:** `captureTheme.ts`: re-base on dark palette — bg `#000000`, surfaces `#1C1C1E`/`#2C2C2E`, accent → `#30D158` (replaces indigo), text = dark-scheme labels; keep the file as the single capture color source; delete unused indigo entries. `tileBgDark/tileFgDark` retire with FoodTile (Task 13) — DetectedCard item tiles switch to `#2C2C2E` squircles + SF food symbol tinted green.
- [ ] **Step 2:** ModePill row → `Segmented`-style dark treatment (keep per-mode behavior + `haptics.selection()`); bubbles get `entering={FadeInDown.duration(250)}`; DetectedCard: dark `Card`, slot chips → dark Segmented, Add-to-diary primary green with success haptic on full success (error haptic on failure bubble path); send button active/disabled colors from tokens (trim gate kept).
- [ ] **Step 3:** All 4 mode behaviors, permission fallbacks, add-all/dedup logic, and invariant (no nutrition fields in payloads) untouched — run the full capture test files unmodified except color/structure queries. `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `feat(ui): capture — dark tokens on new palette, green accent, segmented modes, haptics`

### Task 13: Dead-code sweep (Phase 2 close)

**Files:**
- Delete: `src/components/FoodTile.tsx`, `src/lib/hue.ts` (and `foodVisual` if only FoodTile consumed it — grep first; keep any part log.tsx still uses for symbols)
- Test: trim their test files

- [ ] **Step 1:** Grep `FoodTile|tileBg|tileFg|hue(` across `app/ src/` — replace any straggler usages with the new patterns from Tasks 7–12 (there should be none; fix if found), then delete files + tests. `npx tsc --noEmit` && `npm test -- --ci`, **Commit** — `refactor(ui): retire FoodTile hue-tile system`

---

## Phase 3 — Social + entry screens

Same shared rules. These screens are already thin; each task is mostly mechanical re-composition onto `GroupedSection`/`Row`.

### Task 14: More (Settings pattern)

**Files:** Modify `app/(tabs)/more.tsx`; test `app/(tabs)/__tests__/more.test.tsx`

- [ ] Large title "More". Sections: (1) social — Friends (`users` tint accentBlue), Groups (`person.3.fill` — add `"people": "person.3.fill"` to SYMBOLS, tint accent), Notifications (`bell`, tint accentAmber, unread count as accent Badge on the row `detail`); (2) account — Sign out as destructive Row (confirm flow unchanged). Every row = tinted squircle icon + chevron. Route guards (`r.route` no-op) kept. Update more.test render queries; nav + badge assertions intact. Verify, **Commit** — `feat(ui): More — iOS Settings grouped pattern`

### Task 15: Friends + leaderboard + AddFriendSheet

**Files:** Modify `app/friends.tsx`, `src/components/social/{AddFriendSheet,FriendsLeaderboard}.tsx`; tests alongside.

- [ ] Friends: large title; incoming requests → GroupedSection "Requests" with accept (accent) / decline (secondaryLabel) `PressableScale` circles per row (a11y labels "Accept/Decline request from <name>" kept verbatim); friends → GroupedSection rows (Avatar + name), long-press-unfriend Alert flow kept; Share-progress toggle Row with native `Switch` (`trackColor` accent, same mutation); leaderboard: ranked rows — rank Numeral rounded, "you" row background accent at 8% opacity, metrics Footnote `tabular-nums`, "Not sharing" group tertiary; Add-a-friend primary Button → AddFriendSheet (Sheet v2 inherited; inputs → filled style; code display → Title2 rounded mono-spaced feel with `tabular-nums`; Share ghost kept). All privacy/consent rendering logic untouched. Tests: re-target queries; toggle/accept/error-message assertions intact. **Commit** — `feat(ui): Friends — grouped requests, ranked leaderboard, filled sheet`

### Task 16: Groups + group detail + group sheets

**Files:** Modify `app/groups.tsx`, `app/group/[id].tsx`, `src/components/social/{CreateGroupSheet,RenameGroupSheet,InviteFriendSheet}.tsx`; tests alongside.

- [ ] groups.tsx: large title, GroupedSection rows (name + "N members" Footnote + Owner Badge + chevron), Create/Join primary/secondary Buttons. group/[id]: title2 header block; leaderboard rows as Task 15; roster GroupedSection (owner-only Remove kept as destructive text button per row); challenges section → GroupedSection rows ("status · metric · N in" Footnote); code share Row; owner actions — Rename/Invite Rows, Delete/Leave destructive Row (all Alert/mutation flows + disabled-guards byte-identical). Sheets: filled inputs, primary CTAs. Tests re-targeted; consent/leak assertions (sharing filter, "Not sharing" name-only) run unmodified. **Commit** — `feat(ui): Groups — grouped rosters, iOS action rows`

### Task 17: Challenge + Notifications

**Files:** Modify `app/challenge/[id].tsx`, `app/notifications.tsx`, `src/components/social/CreateChallengeSheet.tsx`; tests alongside.

- [ ] Challenge: header status·metric Footnote + Title1; winner banner → Card with `trophy.fill` symbol (add `"trophy": "trophy.fill"`) accentAmber tint (no emoji); standings → ranked GroupedSection (rank rounded Numeral, score `tabular-nums`); Join primary / Leave secondary / Delete destructive (flows kept). CreateChallengeSheet: metric + duration pickers → `Segmented` (same values sent). Notifications: rows with unread accent dot + relative time Footnote, deep-link/disabled-row/mark-read behaviors byte-identical. Tests re-targeted. **Commit** — `feat(ui): Challenge + Notifications — ranked standings, grouped feed`

### Task 18: Sign-in + Onboarding

**Files:** Modify `app/sign-in.tsx`, `app/onboarding.tsx`; tests alongside.

- [ ] Sign-in: Title1 brand block, filled fields, primary CTA above keyboard (`KeyboardAvoidingView behavior="padding"`), error surfaces kept. Onboarding: Title1 hero (drop any sparkle/emoji), goal cards → GroupedSection selectable Rows with trailing `checkmark` in accent when selected (same three goals/values), numeric fields filled style with existing `validateOnboardingNumbers` gate + a11y labels, sex/activity → `Segmented`, submit flow → replace(/) unchanged, success haptic on submit success. Tests re-targeted; validation-gate assertions unmodified. **Commit** — `feat(ui): Sign-in + Onboarding — iOS forms, segmented pickers`

---

## Phase 4 — Live fidelity pass (controller task, not subagent)

- [ ] Rebuild dev client if not yet done (`npm run ios`), boot backend, sign in demo.
- [ ] Walk EVERY screen in light **and** dark (sim appearance toggle) against the spec §1–3: canvas/card contrast, no borders, type scale, green-only accent, SF symbols rendering (not Circle fallbacks), spring presses, counters, ring sweep, staggers, sheet drag-dismiss, haptic points (device preferred; sim logs acceptable), reduced-motion pass (sim Accessibility → Reduce Motion) — fades not springs, counters snap.
- [ ] Fix findings inline (small) or dispatch fix subagents (behavioral), ledger each.
- [ ] Update `.claude` memory: fidelity gate = this spec (supersedes ui_kits/kora).
- [ ] Final: `npx tsc --noEmit` && `npm test -- --ci` && backend suite untouched-green sanity (`git status` clean outside apps/mobile + docs).

## Self-review notes (already applied)

- Spec coverage: §1 tokens/type/icons/chrome → T1/T3/T5/T6; §2 motion kit/sheet/haptics → T2/T4; §3 screens → T7–T18 + capture T12; §4 gates → per-task verify + Phase 4. Collapsing large-title headers: implemented as static large-title headers in ScrollViews (T5 ScreenHeader + per-screen headers) — native `headerLargeTitle` not used because all tab screens render custom headers; acceptable per spec ("otherwise a shared collapsing header"); collapse-on-scroll deferred as polish if Phase 4 finds it needed.
- Type consistency: `GroupedSection`/`Row`/`Segmented`/`springs`/`haptics`/`AnimatedNumber`/`PressableScale` signatures defined once (T2/T5) and consumed by name everywhere after.
- Payload-preservation proof points: meal.test PATCH-shape (T10), log.test create payload (T11), capture invariant tests (T12), water payload (T8) — all must pass **unmodified**.
