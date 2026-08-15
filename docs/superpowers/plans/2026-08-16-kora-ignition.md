# Kora Ignition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Kora mobile app's four main screens and navigation into the approved "Ignition" design language — one bezel-grade fused instrument per screen, sliding-well dock, once-a-day ignition motion, lume, and edge states.

**Architecture:** New shared primitives (`BezelCluster`, `ZoneRule`, `SpecularSweep`, ignition gating hook) layered on the existing instrument system (`GlassPanel`, `GaugeDial`, `SubDial`, `FloatingTabBar`), then per-screen recompositions. No new native dependencies; everything builds on Reanimated 4, react-native-svg, expo-blur, expo-linear-gradient (add JS-only expo package if absent — check first, `expo-linear-gradient` may need `npx expo install expo-linear-gradient`).

**Tech Stack:** React Native 0.86 / Expo 57, TypeScript, Reanimated 4.5, react-native-svg 15, expo-blur, jest-expo + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-08-16-kora-ignition-design.md` (amends `2026-08-11-kora-instrument-glass-design.md`). Design contract also in `Skill("sketch-findings-kora")`; interactive references in `.planning/sketches/*/index.html`.

## Global Constraints

- **No `@shopify/react-native-skia`**; no new native dependencies at all.
- **Accent budget:** one hero orange moment per screen + dock chrome (active dot, capture button). Sub-dials, goal pips, streak cells: `tickLit`, never `accent`.
- **`NEEDLE_SPRING` in `GaugeDial.tsx` is untouched.** Ignition gets its own named spring.
- **Reduce Motion is a hard gate:** every new animation degrades to instant apply / crossfade (`REDUCED_MOTION_CROSSFADE_MS = 180` exists in `src/motion/springs.ts`).
- **Dynamic Type:** never disable font scaling; cap micro-labels with `maxFontSizeMultiplier` 1.3–1.6.
- "Ignition"/"redline" never appear in user-facing strings.
- Working dir for all commands: `apps/mobile`. Tests: `npx jest <path> --ci --forceExit`. **Do not run `expo lint`** (known broken). Do not touch `src/components/capture/VoiceComposer.tsx` (has unrelated uncommitted work in the main checkout).
- Commits: single-line conventional messages, no signoff/signatures.
- All colors come from `useTheme().instrument` tokens — never literals in components.
- `capture.tsx` stays on `INSTRUMENT_DARK_FIXED` and is OUT OF SCOPE for this plan.

---

### Task 1: Ignition finish tokens

**Files:**
- Modify: `src/theme/palette.ts` (instrumentDark ~line 124–166, instrumentLight ~line 167–224)
- Test: `src/theme/__tests__/instrument.test.ts` (append)

**Interfaces:**
- Produces: `instrument.shade`, `instrument.wellShadow`, `instrument.lumeText`, `instrument.lumeAccent` — strings on both `instrumentDark` and `instrumentLight` (the `satisfies Record<keyof typeof instrumentDark, string>` on the light set enforces parity automatically).

- [ ] **Step 1: Write the failing test** — append to `src/theme/__tests__/instrument.test.ts`:

```ts
describe("ignition finish tokens", () => {
  it("defines the four finish tokens in both schemes", () => {
    for (const set of [instrumentDark, instrumentLight]) {
      expect(set.shade).toMatch(/^rgba\(/);
      expect(set.wellShadow).toMatch(/^rgba\(/);
      expect(set.lumeAccent).toMatch(/^rgba\(/);
      expect(typeof set.lumeText).toBe("string");
    }
  });
  it("turns the text lume off in light mode", () => {
    expect(instrumentLight.lumeText).toBe("transparent");
    expect(instrumentDark.lumeText).not.toBe("transparent");
  });
});
```
(Match the file's existing import style for `instrumentDark`/`instrumentLight`.)

- [ ] **Step 2: Run to verify it fails** — `npx jest src/theme/__tests__/instrument.test.ts --ci --forceExit` → FAIL (`shade` undefined).

- [ ] **Step 3: Implement** — add to `instrumentDark` (before the closing `} as const;`):

```ts
  // Ignition finish (spec 2026-08-16): bezel bottom shading, recessed-well
  // inner line, and the two lume glows. Light mode is a different finish,
  // not a swap — see the light set.
  shade: "rgba(0,0,0,0.28)",
  wellShadow: "rgba(0,0,0,0.25)",
  lumeText: "rgba(237,230,212,0.30)",
  lumeAccent: "rgba(255,74,0,0.45)",
```

and to `instrumentLight`:

```ts
  shade: "rgba(22,24,28,0.12)",
  wellShadow: "rgba(22,24,28,0.08)",
  // OFF by design: a halo behind near-black numerals reads as smudge —
  // daylight dials don't glow.
  lumeText: "transparent",
  lumeAccent: "rgba(210,56,0,0.22)",
```

- [ ] **Step 4: Run the theme test suite** — `npx jest src/theme --ci --forceExit` → all PASS (the `satisfies` clause compiles = parity holds).

- [ ] **Step 5: Commit** — `git commit -m "feat(theme): ignition finish tokens (shade, wellShadow, lume)"`

---

### Task 2: BezelCluster, ZoneRule, WellFooter primitives

**Files:**
- Create: `src/components/instrument/BezelCluster.tsx`
- Test: `src/components/instrument/__tests__/BezelCluster.test.tsx`

**Interfaces:**
- Consumes: `GlassPanel` (`src/components/instrument/GlassPanel.tsx` — props `{children, style, radius, testID}`), `useTheme()` → `{instrument, spacing}` , Task 1 tokens.
- Produces:
  - `BezelCluster({children, radius = 26, style?, glow?, testID?})` — gradient rim wrapping a GlassPanel body; `glow: boolean` adds the faint accent rim glow (hero use only).
  - `ZoneRule({label, testID?})` — engraved label flanked by hairlines.
  - `WellFooter({children, testID?})` — recessed base strip (inset fill + wellShadow top line).

- [ ] **Step 1: Write the failing test** — `__tests__/BezelCluster.test.tsx` (mirror render helpers from the existing `GlassPanel.test.tsx` — reuse its theme-wrapper pattern verbatim):

```tsx
import { render } from "@testing-library/react-native";
import { Text } from "react-native";
import { BezelCluster, ZoneRule, WellFooter } from "../BezelCluster";
// use the same Providers wrapper as GlassPanel.test.tsx

describe("BezelCluster", () => {
  it("renders children inside a rimmed glass body", () => {
    const { getByText, getByTestId } = render(
      <BezelCluster testID="hero"><Text>gauge</Text></BezelCluster>, { wrapper: Providers });
    expect(getByText("gauge")).toBeTruthy();
    expect(getByTestId("hero-rim")).toBeTruthy();
  });
  it("ZoneRule renders an uppercase engraved label", () => {
    const { getByText } = render(<ZoneRule label="Macros" />, { wrapper: Providers });
    expect(getByText("MACROS")).toBeTruthy();
  });
  it("WellFooter paints the recessed inset fill", () => {
    const { getByTestId } = render(
      <WellFooter testID="well"><Text>water</Text></WellFooter>, { wrapper: Providers });
    const style = StyleSheet.flatten(getByTestId("well").props.style);
    expect(style.backgroundColor).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx jest src/components/instrument/__tests__/BezelCluster.test.tsx --ci --forceExit` → FAIL (module not found).

- [ ] **Step 3: Implement** — `BezelCluster.tsx`:

```tsx
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { GlassPanel } from "./GlassPanel";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

// Spec 2026-08-16 "Panel architecture": one bezel-grade instrument per
// screen. The rim is a two-stop linear gradient (conic was cut — RN can't
// draw it without Skia). Clusters wrap fixed-cardinality content only.
const RIM_INSET = 1.5;

export function BezelCluster({ children, radius = 26, style, glow = false, testID }: {
  children: ReactNode; radius?: number; style?: StyleProp<ViewStyle>; glow?: boolean; testID?: string;
}) {
  const { instrument, shadows } = useTheme();
  return (
    <View testID={testID} style={[glow && { shadowColor: instrument.accent, shadowOpacity: 0.3, shadowRadius: 27, shadowOffset: { width: 0, height: 0 } }, style]}>
      <LinearGradient
        testID={testID ? `${testID}-rim` : "bezel-rim"}
        colors={[instrument.glassHighlight, "transparent", instrument.shade]}
        locations={[0, 0.22, 0.9]}
        style={[{ borderRadius: radius + RIM_INSET, padding: RIM_INSET }, shadows.card]}
      >
        <GlassPanel radius={radius}>{children}</GlassPanel>
      </LinearGradient>
    </View>
  );
}

export function ZoneRule({ label, testID }: { label: string; testID?: string }) {
  const { instrument } = useTheme();
  const line = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline } as const;
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 }}>
      <View style={line} />
      <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 10, fontWeight: "600", letterSpacing: 1.5, color: instrument.mut }}>
        {label.toUpperCase()}
      </AppText>
      <View style={line} />
    </View>
  );
}

export function WellFooter({ children, testID }: { children: ReactNode; testID?: string }) {
  const { instrument } = useTheme();
  return (
    <View testID={testID} style={{ backgroundColor: instrument.inset, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: instrument.hairline, paddingVertical: 12, paddingHorizontal: 16, flexDirection: "row", alignItems: "center" }}>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: instrument.wellShadow }} />
      {children}
    </View>
  );
}
```
If `expo-linear-gradient` is not in `package.json` dependencies: `npx expo install expo-linear-gradient` first (JS + prebuilt native, allowed — it ships in the Expo SDK). Adjust `AppText` import path to match how sibling components import it.

- [ ] **Step 4: Run to verify it passes** — same jest command → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(instrument): BezelCluster, ZoneRule, WellFooter primitives"`

---

### Task 3: GaugeDial over-budget state and lume

**Files:**
- Modify: `src/components/instrument/GaugeDial.tsx`
- Test: `src/components/instrument/__tests__/GaugeDial.test.tsx` (append)

**Interfaces:**
- Consumes: existing `GaugeDial({value, target, ...})` and `gauge.ts` geometry (unchanged), Task 1 tokens.
- Produces: over-budget rendering when `value > target`; exported `describeReserve(value, target)` helper returning `{over: boolean, magnitude: number, caption: string}` for reuse and testing.

- [ ] **Step 1: Read `GaugeDial.tsx` and its test file fully.** Note the center-overlay markup, the accessibility label construction, and how the existing tests render the component.

- [ ] **Step 2: Write the failing tests** — append:

```tsx
describe("over budget", () => {
  it("describeReserve reports overage", () => {
    expect(describeReserve(2320, 2100)).toEqual({ over: true, magnitude: 220, caption: "kcal over budget" });
    expect(describeReserve(860, 2100)).toEqual({ over: false, magnitude: 1240, caption: "kcal in reserve" });
  });
  it("renders +N in danger with the over caption and pins the needle", () => {
    const { getByText } = renderGauge({ value: 2320, target: 2100 });
    expect(getByText("+220")).toBeTruthy();
    expect(getByText(/kcal over budget/i)).toBeTruthy();
  });
  it("keeps the calm reserve reading under budget", () => {
    const { getByText } = renderGauge({ value: 860, target: 2100 });
    expect(getByText("1,240")).toBeTruthy();
  });
});
```
(`renderGauge` = whatever helper the existing tests use.)

- [ ] **Step 3: Run to verify failure** — `npx jest src/components/instrument/__tests__/GaugeDial.test.tsx --ci --forceExit` → FAIL.

- [ ] **Step 4: Implement.**
  1. Export the pure helper:
```ts
export function describeReserve(value: number, target: number) {
  const diff = Math.round(target - value);
  return diff < 0
    ? { over: true, magnitude: -diff, caption: "kcal over budget" }
    : { over: false, magnitude: diff, caption: "kcal in reserve" };
}
```
  2. In the center overlay: when `over`, numeral text is `+${fmt(magnitude)}` colored `instrument.danger`, caption colored `instrument.danger`; when not over, keep current rendering but add lume: numeral gets `textShadowColor: instrument.lumeText, textShadowRadius: 22, textShadowOffset: {width: 0, height: 0}`; the accent caption gets the same with `instrument.lumeAccent`, radius 14. **Over state has no lume.** Needle fraction already clamps at 1 — verify, don't change the spring.
  3. Needle glow: render a second `AnimatedLine` immediately *before* the needle with identical animated props but `strokeWidth 7`, `stroke: instrument.accent`, `opacity 0.28` (the RN substitute for drop-shadow; skip when `over` is irrelevant — glow always on the needle).
  4. Update the accessibility label to say "N calories over budget of T" when over.

- [ ] **Step 5: Run the instrument suite** — `npx jest src/components/instrument --ci --forceExit` → PASS (fix any snapshot/recess-invariant fallout honestly — if an existing assertion now conflicts with the spec, update the test citing the 2026-08-16 spec in a comment).

- [ ] **Step 6: Commit** — `git commit -m "feat(instrument): gauge over-budget state, lume glow, needle under-glow"`

---

### Task 4: Ignition sequence (spring, daily gate, count-down, specular sweep)

**Files:**
- Modify: `src/motion/springs.ts`
- Create: `src/motion/useDailyIgnition.ts`
- Create: `src/components/instrument/SpecularSweep.tsx`
- Modify: `src/components/instrument/GaugeDial.tsx` (accept `ignition` prop)
- Test: `src/motion/__tests__/useDailyIgnition.test.ts`

**Interfaces:**
- Consumes: `springs` (`src/motion/springs.ts`), AsyncStorage (`@react-native-async-storage/async-storage`), `describeReserve` from Task 3.
- Produces:
  - `springs.ignition: WithSpringConfig` — `{ damping: 12, stiffness: 180 }` (deliberately underdamped; ONLY for the once-a-day sequence — comment must say so and point at the spec).
  - `useDailyIgnition(todayKey: string): boolean` — returns `true` exactly once per `todayKey` (local-day string, e.g. from the app's existing local-day helper — search `src/` for the local-day utility added in `2026-08-14-kora-local-day`), persisting `kora.ignition.lastPlayed` in AsyncStorage. Returns `false` while loading, when already played, and when Reduce Motion is on (read via the codebase's existing reduce-motion hook — find it with `grep -rn "useReducedMotion\|isReduceMotionEnabled" src/`).
  - `SpecularSweep({radius})` — absolutely-positioned one-shot diagonal highlight; parent must set `overflow: "hidden"`.
  - `GaugeDial` new optional prop `ignition?: boolean`: when true (and not over budget), the needle animates 0 → full → settles at the true fraction using `springs.ignition` for the settle, and the reserve numeral counts down from `target` to the reserve over ~1650ms (Reanimated `useSharedValue` + `withTiming` + `useAnimatedProps` on a text — check whether the codebase already has an AnimatedNumber primitive: `grep -rn "AnimatedNumber" src/` per the crash-history comment in GaugeDial; reuse it if alive).

- [ ] **Step 1: Write the failing hook test** — `src/motion/__tests__/useDailyIgnition.test.ts` using `@testing-library/react-native`'s `renderHook` and the jest AsyncStorage mock (jest-expo provides one; if not, `jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"))`):

```ts
it("fires once per day", async () => {
  const first = renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(first.result.current).toBe(true));
  const second = renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(second.result.current).toBe(false));
});
it("fires again on a new day", async () => {
  await AsyncStorage.setItem("kora.ignition.lastPlayed", "2026-08-15");
  const { result } = renderHook(() => useDailyIgnition("2026-08-16"));
  await waitFor(() => expect(result.current).toBe(true));
});
```

- [ ] **Step 2: Run to verify failure**, then implement `useDailyIgnition`:

```ts
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "kora.ignition.lastPlayed";

export function useDailyIgnition(todayKey: string, reducedMotion = false): boolean {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (reducedMotion) return;
    let live = true;
    AsyncStorage.getItem(KEY).then((last) => {
      if (!live || last === todayKey) return;
      AsyncStorage.setItem(KEY, todayKey);
      setPlay(true);
    });
    return () => { live = false; };
  }, [todayKey, reducedMotion]);
  return play;
}
```
(Wire the real reduce-motion value at the call site in Task 6.)

- [ ] **Step 3: Run hook test → PASS. Commit** — `git commit -m "feat(motion): ignition spring and once-per-day gate"` (include the `springs.ignition` addition).

- [ ] **Step 4: SpecularSweep** — implement, no test beyond a smoke render appended to `BezelCluster.test.tsx`:

```tsx
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming, Easing } from "react-native-reanimated";
import { useTheme } from "@/theme";

// One-shot highlight band that crosses the cluster glass on mount.
// Parent clips (GlassPanel already has overflow: hidden).
export function SpecularSweep({ width = 400 }: { width?: number }) {
  const { instrument } = useTheme();
  const x = useSharedValue(-width);
  useEffect(() => {
    x.value = withDelay(500, withTiming(width, { duration: 1600, easing: Easing.bezier(0.4, 0, 0.2, 1) }));
  }, [width, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { rotate: "20deg" }] }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <LinearGradient colors={["transparent", instrument.glassHighlight, "transparent"]}
        start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
        style={{ width: 90, height: "160%", alignSelf: "center", opacity: 0.8 }} />
    </Animated.View>
  );
}
```
Skip mounting it entirely under Reduce Motion (caller's responsibility, Task 6).

- [ ] **Step 5: GaugeDial `ignition` prop.** Sequence with Reanimated on the existing needle shared value: `withSequence(withTiming(1, {duration: 650, easing: Easing.in(Easing.quad)}), withSpring(trueFraction, springs.ignition))`. Count-down: drive the center numeral from an animated value `target → reserve` over 1650ms ease-out; format with the component's existing formatter. Existing non-ignition behavior byte-identical (guard every change behind the prop). Run `npx jest src/components/instrument --ci --forceExit` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(instrument): ignition sequence, count-down, specular sweep"`

---

### Task 5: Dock v2 — sliding well, labels, domed capture button

**Files:**
- Modify: `src/components/FloatingTabBar.tsx`
- Test: `src/components/__tests__/FloatingTabBar.test.tsx` (create or append — check for an existing test first)

**Interfaces:**
- Consumes: Tasks 1–2 tokens; existing tab config (4 routes + CaptureButton sibling); `springs.lively`; `expo-haptics`.
- Produces: same external API (it's the `tabBar` render prop of `app/(tabs)/_layout.tsx`) — no call-site changes.

- [ ] **Step 1: Read `FloatingTabBar.tsx` fully.** Preserve: sibling raised CaptureButton, `pointerEvents="box-none"`, reduce-transparency fallback, unread badge, accessibility labels, `maxFontSizeMultiplier` cap.

- [ ] **Step 2: Write failing tests** (behavior-level):

```tsx
it("renders always-visible labels for every tab", () => {
  const { getByText } = renderTabBar();
  for (const l of ["TODAY", "DIARY", "TRENDS", "MORE"]) expect(getByText(l)).toBeTruthy();
});
it("renders a single sliding active well", () => {
  const { getByTestId } = renderTabBar();
  expect(getByTestId("dock-well")).toBeTruthy();
});
```
(Build `renderTabBar` from a minimal mocked `BottomTabBarProps`-shaped object matching how the component consumes expo-router's tabBar props — read the component to see the exact shape.)

- [ ] **Step 3: Implement.**
  1. **Geometry:** pill `minHeight 58` (was 64), outer wrapped in a rim `LinearGradient` (`glassHighlight → transparent 30% → shade 92%`, padding 1.5, borderRadius 31) — reuse the gradient recipe from `BezelCluster`, but inline here (different radii/stops; a shared abstraction is premature).
  2. **Sliding well:** one `Animated.View` inside the pill — full-pill shape (height 44, `borderRadius 22` — the dock silhouette miniaturized, spec "dock v2"), `backgroundColor: instrument.inset`, top inner line of `wellShadow`, and the 4px accent dot (with `shadowColor: accent, shadowOpacity 0.7, shadowRadius 8`) centered at its bottom. On tab change animate `translateX` with `withSpring(x, springs.lively)` and width to the tab's measured width (`onLayout` per tab, stored in a ref array). The well replaces the current per-tab active-well styling — delete that.
  3. **Icon pop:** on press, the icon scale runs `withSequence(withTiming(0.82, {duration: 140}), withSpring(1, springs.lively))` — reuse the component's existing scale mechanism if present.
  4. **Labels:** always rendered — inactive `opacity 0.72 / weight 500`, active `1 / 700`; keep the existing 9px size and `maxFontSizeMultiplier`.
  5. **Capture button:** keep architecture; restyle face with a `LinearGradient` (`[mix of white into accent, accent, mix of black into accent]` — precompute two hex constants next to the component with a comment, e.g. `#FF8149` and `#C93A00` for dark scheme, derived from `#FF4A00`; for light scheme derive from `#D23800`: `#E2703D`/`#A62C00`), raise stays 16, glow shadow stays.
  6. **Haptics:** `Haptics.selectionAsync()` on tab switch; `Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)` on capture press (only if the component doesn't already fire one — check).
  7. **Reduce Motion:** well jumps (`withTiming(x, {duration: 0})`), no pop.

- [ ] **Step 4: Run** — `npx jest src/components --ci --forceExit` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(nav): dock v2 — bezel rim, sliding pill well, always-on labels, domed capture"`

---

### Task 6: Home recomposition

**Files:**
- Modify: `app/(tabs)/index.tsx`
- Modify: `src/components/instrument/SubDial.tsx` (lit color)
- Modify: `src/components/instrument/MacroWide.tsx` only if reused; otherwise the macro rail is new local components in `index.tsx`'s file scope
- Test: append to `src/components/instrument/__tests__/SubDial.test.tsx`; screen-level assertions in a new `app/(tabs)/__tests__/index.test.tsx` only if a screen test harness already exists — otherwise component-level tests suffice (check `app/` for existing screen tests first; do not invent a new harness).

**Interfaces:**
- Consumes: `BezelCluster`/`ZoneRule`/`WellFooter`, `GaugeDial` (+`ignition`), `useDailyIgnition`, `SpecularSweep`, `describeReserve`, existing data hooks in `index.tsx` (do not change data fetching).
- Produces: the recomposed Home screen per spec "Per-screen contracts".

- [ ] **Step 1: SubDial accent → lit-ink.** Failing test first (append to `SubDial.test.tsx`): assert lit segment stroke equals `instrument.tickLit`, not `instrument.accent` (read the existing test to see how strokes are asserted). Implement: change the lit-tick color source; keep the `tokens` override prop working. Comment: `// spec 2026-08-16 accent budget: orange belongs to the hero needle alone`. Run → PASS. Commit `git commit -m "fix(instrument): sub-dials light in ink, not accent"`.

- [ ] **Step 2: Recompose the hero.** In `index.tsx`, replace the current stack [Energy GlassPanel, MacroWide, Carbs/Fat pair, TeleStrip] with ONE `BezelCluster` (radius 26):

```tsx
<BezelCluster glow testID="home-hero">
  {ignite && <SpecularSweep />}
  <View style={{ padding: 16 }}>
    <EngravedLabel>Energy reserve</EngravedLabel>
    <GaugeDial value={eaten} target={goal} ignition={ignite} />
  </View>
  <ZoneRule label="Macros" />
  <View style={{ flexDirection: "row" }}>
    {MACROS.map((m, i) => (
      <MacroCell key={m.key} first={i === 0} label={m.label} have={m.have} target={m.target} />
    ))}
  </View>
  <WellFooter testID="home-vitals">
    {/* steps + sleep cells: keep TeleStrip's data wiring, restyle inline */}
  </WellFooter>
</BezelCluster>
```
`ignite = useDailyIgnition(todayKey, reducedMotion)`. `MacroCell` (local component in the same file, or a new `src/components/home/MacroCell.tsx` if `index.tsx` would exceed ~800 lines): SubDial 42 + 11px label + mono `have/targetg` + 2px ink microbar on an inset track + 10px mono "Ng to go", left hairline between cells. Preserve the pending/placeholder state the current hero has (em-dash placeholder while loading).

- [ ] **Step 3: Edge states.** Empty log (no meals): render the instrument EmptyState variant (`src/components/common/EmptyState.tsx`) with camera icon, title "No meals logged yet", subtitle "The gauge is full and waiting. Point the camera at your first meal." Over-budget comes free from Task 3 (`value > target`). Keep the existing "Logged today" hairline list, ghost CTA, and saved/pinned strips exactly as they are.

- [ ] **Step 4: Odometer roll on data change.** When `value` changes on an already-mounted `GaugeDial` (a meal was logged) and ignition is not playing and not over budget, the center numeral animates from the previous reserve to the new one over ~550ms ease-out (same animated-number mechanism as the ignition count-down — in `GaugeDial`, track the previous value with a ref and drive the shared value from old → new instead of snapping). The needle keeps its existing critically-damped `NEEDLE_SPRING` motion. Macro cell numerals get a small rise-in on change: `entering={FadeInDown.duration(350)}` keyed by the value, or an equivalent 9px translateY + fade via a keyed `Animated.View`. Both skipped under Reduce Motion.

- [ ] **Step 5: Pull-to-refresh sweep.** The screen's ScrollView gets/keeps a `RefreshControl` with `tintColor="transparent"`; on refresh-begin trigger a needle sweep: give `GaugeDial` an imperative handle `ref.sweep()` (add `useImperativeHandle` exposing a `sweep()` that runs full-and-back with `withSequence`), call it from `onRefresh` alongside the existing refetch. Skip under Reduce Motion.

- [ ] **Step 6: Verify.** `npx jest src/components/instrument src/motion --ci --forceExit` → PASS. Then boot the app in the iPhone 17 Pro Max simulator (`npx expo run:ios` or the project's usual dev-client flow) and visually confirm: ignition plays once (relaunch → calm settle), scenario with meals > budget shows the calm over state, blur scroll performance acceptable. Note: most runtime flows are auth-walled (see repo memory) — visual check of Home may require the existing signed-in dev account/session.

- [ ] **Step 7: Commit** — `git commit -m "feat(home): fused ignition hero cluster, edge states, odometer, refresh sweep"`

---

### Task 7: Diary recomposition

**Files:**
- Modify: `app/(tabs)/diary.tsx`
- Test: component-level only (the pieces are Tasks 1–2 primitives); any pure helpers extracted (slot subtotal formatting) get unit tests beside them.

**Interfaces:**
- Consumes: `BezelCluster`, `ZoneRule`, `WellFooter`; existing diary data hooks, water mutation, week-strip data (do not change data fetching).
- Produces: Diary per spec contract.

- [ ] **Step 1: Read `diary.tsx` fully.** Map: week strip, day-total panel, per-slot meal groups, ghost slot CTA, water pills, copy/repeat rows.

- [ ] **Step 2: Week rail.** Wrap the 7-cell strip in a small `BezelCluster` (radius 21, no glow). Selected cell: `inset` fill + `wellShadow` top line + `glassBorder` ring (replace the current glass-fill selection). Goal pips: `tickLit` when hit (NOT accent — spec accent budget), `tick` otherwise, no glow. Each cell keeps ≥44pt touch height; `Haptics.selectionAsync()` on day tap if not already present.

- [ ] **Step 3: Day cluster.** One `BezelCluster` containing ONLY: engraved "Day total" + mono total + animated 6px accent track (animate width `withTiming` ~1100ms ease-out on mount/day change; instant under Reduce Motion — this track is Diary's ONE accent), then `WellFooter` with the water readout + the existing +250/+500 pill buttons restyled as inset pills (`impactLight` haptic on tap if absent).

- [ ] **Step 4: Meal log stays OUTSIDE.** Per-slot groups become zone-ruled hairline sections directly on the ground (ZoneRule label "BREAKFAST · 380 KCAL" style — slot + mono subtotal), rows keep their existing swipe/edit behavior untouched. Ghost "Add dinner · N kcal in reserve" dashed CTA and copy-yesterday row keep their current wiring, restyled to match (dashed `tick` border, accent plus glyph).

- [ ] **Step 5: Verify + commit.** `npx jest src/components --ci --forceExit` → PASS; visual pass on simulator. `git commit -m "feat(diary): week rail + day cluster, meal log split out per ignition spec"`

---

### Task 8: Trends and More restyles

**Files:**
- Modify: `app/(tabs)/progress.tsx`, `app/(tabs)/more.tsx`
- Modify: `src/components/instrument/StreakCells.tsx` (hit color), `src/components/instrument/EnergyBars.tsx` (over-budget bar color + grow-in), `WeightChart` (draw-in + endpoint lume — locate via `grep -rn "WeightChart" src/`)
- Test: append to `src/components/instrument/__tests__/strips.test.tsx` (or the components' own test files) for the color demotions.

**Interfaces:**
- Consumes: Tasks 1–2 primitives; existing chart components and data hooks.
- Produces: Trends + More per spec contracts.

- [ ] **Step 1: Color demotions, test-first.** Failing tests: StreakCells hit cells render `tickLit` (not accent); EnergyBars only over-budget bars use `accent`, others `tick`; weight delta color = `ink` when moving toward goal, `danger` when away (make the delta a pure helper `deltaColor(delta, goalDirection, instrument)` with unit tests: losing weight with a loss goal → ink; gaining with a loss goal → danger). Implement, run, PASS.

- [ ] **Step 2: Trends layout.** Weight panel becomes the screen's `BezelCluster` (glow, radius 26): engraved "Weight", 34px mono figure (lume via `lumeText` shadow), delta, chart, `SegmentedGlass` unchanged. Chart draw-in: animate `strokeDashoffset` from path length → 0 over ~1100ms on mount (react-native-svg `Path` + Reanimated `useAnimatedProps`, mirroring the needle pattern in GaugeDial); endpoint dot `accent` with a soft halo circle (opacity 0.22, r 8). Energy panel stays a plain `GlassPanel`; bars grow from baseline staggered (i * 50ms, ~700ms, ease-out; instant under Reduce Motion). Streak/sleep duo tiles stay `GlassPanel radius 20`.

- [ ] **Step 3: More layout.** Identity hero → `BezelCluster` (radius 25) with the avatar tile getting a whisper glow (`shadowColor: accent, shadowOpacity 0.35, shadowRadius 24` on the avatar well — this is the screen's one accent). Group panels stay `GlassPanel radius 22`; icon wells get the `wellShadow` top line. No other changes — rows, badge (teal), sign-out, wiring untouched.

- [ ] **Step 4: Verify + commit.** Suite green + simulator pass. `git commit -m "feat(trends,more): bezel heroes, chart motion, accent demotions"`

---

### Task 9: Screen transitions, haptics sweep, reduced-motion audit

**Files:**
- Create: `src/motion/ScreenEntrance.tsx`
- Modify: the four screens in `app/(tabs)/` (wrap content), `FloatingTabBar.tsx` (tab-index direction context if needed)
- Test: `src/motion/__tests__/gestureWorkletBoundary.test.ts` untouched; new `src/motion/__tests__/screenEntrance.test.tsx` smoke render.

**Interfaces:**
- Consumes: expo-router `useFocusEffect`/navigation state, Reanimated, `REDUCED_MOTION_CROSSFADE_MS`.
- Produces: `ScreenEntrance({children, direction})` — on focus, fades in from `opacity 0, translateX ±16` over 280ms ease-out; direction derived from previous vs next tab index (store last index in a module-level ref shared with the tab bar, or read navigation state history — read `_layout.tsx` and pick the simpler wiring). Reduce Motion → 180ms opacity-only crossfade.

- [ ] **Step 1: Implement `ScreenEntrance` + smoke test** (renders children; applies animated style). Wrap each tab screen's root content view.

- [ ] **Step 2: Haptics + reduced-motion audit.** Grep every animation added in Tasks 3–8 and verify each has its Reduce Motion branch (checklist in commit message): ignition, count-down, specular, sweep-refresh, dock well/pop, day track, chart draw-in, bar growth, entrances. Verify haptics: dock selection, capture impactMedium, water impactLight, day-tap selection, ignition-settle impactLight (add in GaugeDial's ignition completion callback via `runOnJS`).

- [ ] **Step 3: Full suite + lint-free build.** `npx jest --ci --forceExit` (whole mobile suite) → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit** — `git commit -m "feat(motion): directional screen entrances, haptics map, reduce-motion audit"`
