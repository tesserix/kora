# Auth Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sharpen Kora's pre-app flow — sign-in, link prompt, entry gate, onboarding — fixing an App Store compliance blocker, the wrong brand mark, and a gap that strands new users in an empty app.

**Architecture:** Four new presentation-only components in `apps/mobile/src/components/` (`BrandMark`, `AppleSignInButton`, `GoogleSignInButton`, `Field`), then four screens recomposed on top of them. No auth logic moves: `socialCredentials.ts`, `link.ts`, `socialAuth.ts` and `firebaseAuthMessage.ts` keep their branching. The entry gate changes from a post-render redirect effect into a render gate resolved before `<Tabs>` mounts.

**Tech Stack:** Expo SDK 57, React Native, TypeScript, expo-router, `expo-apple-authentication` ~57.0.1, `react-native-svg` 15.15.4, `@tanstack/react-query`, Jest + `@testing-library/react-native` 14.

**Spec:** `docs/superpowers/specs/2026-08-07-auth-flow-redesign-design.md` (amended at `7b615b1`)
**Branch:** `feat/auth-flow-redesign` (already checked out)

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Expo is version-pinned and has changed.** `apps/mobile/AGENTS.md` requires reading the exact versioned docs at `https://docs.expo.dev/versions/v57.0.0/` before writing code that touches an Expo module. This applies to Task 2 (`expo-apple-authentication`).
- **All work is inside `apps/mobile/`** except Task 1's kit correction, which touches `design-system/ui_kits/kora/`.
- **RNTL 14 requires `await render(...)`.** A missing `await` is a defect this project has already shipped twice. Async queries (`findBy*`) are awaited; presses that trigger state updates are wrapped in `act`.
- **NEVER `jest.mock("react-native/Libraries/Utilities/Platform", …)`.** It breaks module resolution before any test runs, crashing the whole suite with `Cannot read properties of undefined (reading 'select')`. Patch the two properties on the real singleton instead — the exact working pattern is in `src/components/auth/__tests__/LinkAccountPrompt.android.test.tsx:23-34`, reproduced in Task 2.
- **Dark palette** (`src/theme/palette.ts`, the values in play): `background #0A0D0B`, `card #151A16`, `cardSecondary #1C231D`, `primary #3DDC6E`, `primaryForeground #06120A`, `label #F3F7F2`, `border rgba(255,255,255,0.09)`. Never bake hex into a component — read from `useTheme()`.
- **Suite baseline:** `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit` → 129 suites / 887 tests green.
- **`console.error` output from `hooks.test.tsx`, `useQueuedLogs.test.tsx` and `useActivityHistory.test.tsx` is PRE-EXISTING.** Proven against `main` in a throwaway worktree. Do not chase it.
- **Never stage `apps/mobile/eslint.config.js`.** `npx expo lint` regenerates it; it is untracked on purpose.
- **Commits:** conventional prefix, **single line**, no body, no trailers, no signature.
- **Every task ends with a mutation step.** Break the implementation, name the *exact* test that must fail. **If the mutation makes everything fail, it has proven nothing** — it cannot distinguish "the feature works" from "no code runs at all". Narrow the mutation until exactly the named test goes red.
- **Absence assertions must follow a presence.** Before asserting a thing is gone, reach a state in the same suite where a wrong implementation would render it.

---

## File Structure

**Create:**
- `src/components/BrandMark.tsx` — the 3×3 dot grid. Presentation only, takes `size`.
- `src/components/__tests__/BrandMark.test.tsx`
- `src/components/auth/AppleSignInButton.tsx` — wraps Apple's native button; returns `null` off iOS.
- `src/components/auth/__tests__/AppleSignInButton.test.tsx` (iOS)
- `src/components/auth/__tests__/AppleSignInButton.android.test.tsx` (Android)
- `src/components/auth/GoogleSignInButton.tsx` — Google's dark branding spec, SVG G mark.
- `src/components/auth/__tests__/GoogleSignInButton.test.tsx`
- `src/components/Field.tsx` — labelled input with optional error slot.
- `src/components/__tests__/Field.test.tsx`
- `app/__tests__/tabs-layout.test.tsx` — the entry gate; no test exists today.

**Modify:**
- `src/components/BrandLockup.tsx` — swap the sparkles tile for `BrandMark`; re-point the comment.
- `src/components/__tests__/BrandLockup.test.tsx` — currently asserts `sf-sparkles` and a filled tile; both become false.
- `design-system/ui_kits/kora/{Chrome,Onboarding,HomeScreen}.jsx` — the three brand tiles only.
- `app/sign-in.tsx` — social-first first paint, reveal, mode moves to footer, `Segmented` removed.
- `app/__tests__/sign-in-social.test.tsx` — provider button labels change.
- `src/components/auth/LinkAccountPrompt.tsx` — copy reframe + branded buttons.
- `src/components/auth/__tests__/LinkAccountPrompt.test.tsx`, `.android.test.tsx` — label changes.
- `app/(tabs)/_layout.tsx` — redirect effect becomes a render gate.
- `app/onboarding.tsx` — `Field` for the three step-2 inputs.

---

### Task 1: BrandMark, and the kit that taught us the wrong mark

Kora's real mark is `apps/mobile/assets/images/icon.png`: a 3×3 grid, six large dots in `primary`, three smaller muted dots at top-centre, middle-right and bottom-centre.

**Files:**
- Create: `apps/mobile/src/components/BrandMark.tsx`
- Create: `apps/mobile/src/components/__tests__/BrandMark.test.tsx`
- Modify: `apps/mobile/src/components/BrandLockup.tsx`
- Modify: `apps/mobile/src/components/__tests__/BrandLockup.test.tsx`
- Modify: `apps/mobile/app/__tests__/onboarding.test.tsx:47` — asserts `sf-sparkles` via `BrandLockup`
- Modify: `apps/mobile/app/__tests__/sign-in.test.tsx:53` — same assertion
- Modify: `design-system/ui_kits/kora/Chrome.jsx:34`, `Onboarding.jsx:18`, `HomeScreen.jsx:93`

**Do NOT touch `apps/mobile/src/components/__tests__/Icon.test.tsx:15`.** It also
asserts `sf-sparkles`, but it tests the `Icon` component directly — `Icon` still
supports the sparkles glyph and that test stays true. Changing it would be
collateral damage from a careless grep.

**Interfaces:**
- Consumes: `useTheme()` from `@/theme` → `{ colors }`.
- Produces: `BrandMark({ size }: { size?: number })`, default `size = 40`. Renders nine `View`s with `testID={`brand-dot-${row}-${col}`}`, rows and cols 0-indexed. Tasks 5, 6 and 8 rely on this name and on the default size.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/BrandMark.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { BrandMark } from "../BrandMark";
import { darkColors } from "@/theme/palette";

// The three muted positions, as row/col. Everything else is a large primary dot.
const MUTED = [
  [0, 1], // top-centre
  [1, 2], // middle-right
  [2, 1], // bottom-centre
] as const;

function styleOf(node: { props: { style: unknown } }) {
  const s = node.props.style;
  return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s;
}

test("renders a 3x3 grid of nine dots", async () => {
  const { getByTestId } = await render(<BrandMark />);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      expect(getByTestId(`brand-dot-${r}-${c}`)).toBeTruthy();
    }
  }
});

// A test that only counted nine dots would pass against a uniform grid, which
// is the wrong mark. Position and colour are the whole point.
test("the three muted dots sit at top-centre, middle-right and bottom-centre", async () => {
  const { getByTestId } = await render(<BrandMark />);

  for (const [r, c] of MUTED) {
    const style = styleOf(getByTestId(`brand-dot-${r}-${c}`));
    expect(style.backgroundColor).toBe(darkColors.cardSecondary);
  }

  const mutedKeys = new Set(MUTED.map(([r, c]) => `${r}-${c}`));
  let large = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (mutedKeys.has(`${r}-${c}`)) continue;
      const style = styleOf(getByTestId(`brand-dot-${r}-${c}`));
      expect(style.backgroundColor).toBe(darkColors.primary);
      large++;
    }
  }
  expect(large).toBe(6);
});

test("the muted dots are visibly smaller than the primary ones", async () => {
  const { getByTestId } = await render(<BrandMark />);
  const largeStyle = styleOf(getByTestId("brand-dot-0-0"));
  const mutedStyle = styleOf(getByTestId("brand-dot-0-1"));
  expect(mutedStyle.width).toBeLessThan(largeStyle.width);
  // ~60% of the large diameter, matching icon.png.
  expect(mutedStyle.width / largeStyle.width).toBeCloseTo(0.6, 1);
});

test("dots scale with the size prop and stay circular", async () => {
  const { getByTestId } = await render(<BrandMark size={80} />);
  const style = styleOf(getByTestId("brand-dot-0-0"));
  expect(style.width).toBe(style.height);
  expect(style.borderRadius).toBeCloseTo(style.width / 2, 5);
  expect(style.width).toBeGreaterThan(20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/components/__tests__/BrandMark.test.tsx --ci`
Expected: FAIL — `Cannot find module '../BrandMark'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/components/BrandMark.tsx`:

```tsx
import { View } from "react-native";
import { useTheme } from "@/theme";

// Kora's mark, from assets/images/icon.png: a 3x3 grid of dots. Six large in
// `primary`; three smaller muted ones at top-centre, middle-right and
// bottom-centre. Plain Views — the shape is circles, so SVG buys nothing.
//
// This is the source of truth for the mark. It is NOT the Lucide `sparkles`
// glyph that BrandLockup used to render; that came from the prototype kit and
// was never Kora's mark.
const MUTED_POSITIONS = new Set(["0-1", "1-2", "2-1"]);

// Fraction of a grid cell taken up by a large dot, and the muted dots'
// diameter relative to a large one. Both measured off icon.png.
const LARGE_DOT_RATIO = 0.82;
const MUTED_DOT_RATIO = 0.6;

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 40 }: BrandMarkProps) {
  const { colors } = useTheme();
  const cell = size / 3;
  const largeDot = cell * LARGE_DOT_RATIO;
  const mutedDot = largeDot * MUTED_DOT_RATIO;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      {[0, 1, 2].map((row) => (
        <View key={row} style={{ flexDirection: "row", height: cell }}>
          {[0, 1, 2].map((col) => {
            const muted = MUTED_POSITIONS.has(`${row}-${col}`);
            const diameter = muted ? mutedDot : largeDot;
            return (
              <View
                key={col}
                style={{ width: cell, height: cell, alignItems: "center", justifyContent: "center" }}
              >
                <View
                  testID={`brand-dot-${row}-${col}`}
                  style={{
                    width: diameter,
                    height: diameter,
                    borderRadius: diameter / 2,
                    backgroundColor: muted ? colors.cardSecondary : colors.primary,
                  }}
                />
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/components/__tests__/BrandMark.test.tsx --ci`
Expected: PASS, 4 tests.

- [ ] **Step 5: Update BrandLockup to use it**

Replace the sparkles tile in `apps/mobile/src/components/BrandLockup.tsx`. The whole file becomes:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { BrandMark } from "./BrandMark";
import { useTheme } from "@/theme";

// The Kora brand lockup: the dot-grid mark beside the wordmark. Shown at the
// top of the pre-app screens (sign-in and onboarding step 1).
//
// The mark's source of truth is assets/images/icon.png, NOT
// design-system/ui_kits/kora/Onboarding.jsx — that kit rendered a Lucide
// `sparkles` glyph in a filled tile, which was never Kora's mark. The kit has
// been corrected to match; if the two ever disagree again, the icon wins.
//
// There is no filled tile any more: icon.png is dots on a near-black field,
// and `background` is exactly that field, so a tile would be invisible at best
// and would fight the mark's own green at worst.
export function BrandLockup() {
  const { spacing } = useTheme();

  return (
    <View
      accessibilityRole="header"
      accessibilityLabel="Kora"
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm + 2 }}
    >
      <BrandMark size={40} />
      <AppText variant="title2" style={{ letterSpacing: -0.4 }}>
        Kora
      </AppText>
    </View>
  );
}
```

- [ ] **Step 6: Replace BrandLockup's now-false tests**

`src/components/__tests__/BrandLockup.test.tsx` asserts `sf-sparkles` and a 40×40 filled tile. Both are deliberately no longer true. Replace the whole file:

```tsx
import { render } from "@testing-library/react-native";
import { BrandLockup } from "../BrandLockup";

test("renders the Kora wordmark beside the dot-grid mark", async () => {
  const { getByText, getByTestId } = await render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(getByTestId("brand-dot-2-2")).toBeTruthy();
});

// The old lockup rendered a Lucide sparkles glyph in a primary-filled tile.
// Asserting the wordmark still renders first means this is a disappearance,
// not a component that failed to mount at all.
test("no longer renders the sparkles glyph or its tile", async () => {
  const { getByText, queryByTestId } = await render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(queryByTestId("sf-sparkles")).toBeNull();
  expect(queryByTestId("brand-mark-tile")).toBeNull();
});
```

- [ ] **Step 6b: Update the two screen tests that assert the old mark**

Both screens render `BrandLockup`, so both suites assert the sparkles testID and both go red on Step 5. This is expected — the mark deliberately changed.

In `apps/mobile/app/__tests__/onboarding.test.tsx:47`, inside `step 1 shows the brand, the hero and the goal cards`, replace:

```tsx
  expect(ui.getByTestId("sf-sparkles")).toBeTruthy();
```

with:

```tsx
  expect(ui.getByTestId("brand-dot-0-0")).toBeTruthy();
```

Make the identical replacement in `apps/mobile/app/__tests__/sign-in.test.tsx:53`.

Again: leave `src/components/__tests__/Icon.test.tsx:15` alone.

- [ ] **Step 7: Correct the three kit brand tiles**

The kit is prototype JSX with no tests; correct it by inspection so it stops being cited as the authority for a mark it gets wrong.

In each of `design-system/ui_kits/kora/Chrome.jsx:34`, `Onboarding.jsx:18` and `HomeScreen.jsx:93`, replace the sparkles brand tile's icon with the dot grid. Each site currently looks like `<Icon name="sparkles" size={22} color="var(--primary-foreground)" />` (sizes 22–24) inside a `primary`-filled tile. Replace that single element with:

```jsx
{/* Kora's mark: a 3x3 dot grid (see apps/mobile/assets/images/icon.png and
    apps/mobile/src/components/BrandMark.tsx). NOT the sparkles glyph, which
    is this app's AI affordance and must stay everywhere else in this kit. */}
<span style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2, width: 22, height: 22 }}>
  {[[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]].map(([r, c]) => {
    const muted = `${r}-${c}` === "0-1" || `${r}-${c}` === "1-2" || `${r}-${c}` === "2-1";
    const d = muted ? 3.5 : 6;
    return (
      <span key={`${r}-${c}`} style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ width: d, height: d, borderRadius: "50%", background: muted ? "var(--card-secondary)" : "var(--primary-foreground)" }} />
      </span>
    );
  })}
</span>
```

**Do not touch the kit's other ten `sparkles`.** They are the AI affordance — "Otto's take", "AI logged", "AI-matched", "Regenerate", "Weekly report" — in `ProgressScreen`, `PlannerScreen`, `RestaurantScreen` (×2), `CoachScreen`, `InsightsScreen`, `MealDetail`, `CaptureScreen` (×2) and `HomeScreen:49`. A blanket find-and-replace destroys the AI iconography and is the failure the next step exists to catch.

- [ ] **Step 8: Verify the kit count**

Run: `cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora && grep -rc "sparkles" design-system/ui_kits/kora/ | awk -F: '{s+=$2} END {print s}'`
Expected: `10` (down from 13 — exactly the three brand tiles removed).

Also confirm `HomeScreen.jsx` still has its line-49 AI sparkle:
Run: `grep -c "sparkles" design-system/ui_kits/kora/HomeScreen.jsx`
Expected: `1`.

- [ ] **Step 9: Run the mutation**

In `BrandMark.tsx`, change `MUTED_POSITIONS` to `new Set(["0-1", "1-1", "2-1"])` — the whole centre column muted instead of the real pattern.

Run: `cd apps/mobile && npx jest src/components/__tests__/BrandMark.test.tsx --ci`
Expected: **exactly** `the three muted dots sit at top-centre, middle-right and bottom-centre` FAILS. The grid test, the size-ratio test and the scaling test must all still PASS — that is what proves the position assertion is doing work rather than the component merely rendering.

If more than that one test fails, the mutation was too broad. Revert it and try again.

Revert the mutation before committing.

- [ ] **Step 10: Run the full mobile suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: green. Note the suite/test counts have grown from the 129/887 baseline.

- [ ] **Step 11: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/BrandMark.tsx \
        apps/mobile/src/components/__tests__/BrandMark.test.tsx \
        apps/mobile/src/components/BrandLockup.tsx \
        apps/mobile/src/components/__tests__/BrandLockup.test.tsx \
        design-system/ui_kits/kora/Chrome.jsx \
        design-system/ui_kits/kora/Onboarding.jsx \
        design-system/ui_kits/kora/HomeScreen.jsx
git commit -m "feat(mobile): replace the sparkles lockup with Kora's dot-grid brand mark"
```

---

### Task 2: AppleSignInButton

Apple's HIG makes the mark and approved styles mandatory. This is the App Store compliance fix, and it gates #109.

**Files:**
- Create: `apps/mobile/src/components/auth/AppleSignInButton.tsx`
- Create: `apps/mobile/src/components/auth/__tests__/AppleSignInButton.test.tsx`
- Create: `apps/mobile/src/components/auth/__tests__/AppleSignInButton.android.test.tsx`

**Interfaces:**
- Consumes: `useTheme()` → `{ radius }`. `expo-apple-authentication` (read `https://docs.expo.dev/versions/v57.0.0/sdk/apple-authentication/` first).
- Produces: `AppleSignInButton({ onPress, accessibilityLabel, disabled }: AppleSignInButtonProps)`. `accessibilityLabel` is **required** — Tasks 5 and 7 pass different labels ("Sign in with Apple" vs "Continue with Apple to link") because the native button renders Apple's own text and cannot express "to link".

- [ ] **Step 1: Write the failing iOS test**

Create `apps/mobile/src/components/auth/__tests__/AppleSignInButton.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";
import { radius } from "@/theme/palette";

// jest-expo's default platform is ios, so no Platform patching is needed here.
// The Android counterpart lives in AppleSignInButton.android.test.tsx.
jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    // Stands in for the native view so props are inspectable in the tree.
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});

test("renders Apple's own button on iOS", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  expect(getByLabelText("Sign in with Apple")).toBeTruthy();
});

// BLACK would disappear on #0A0D0B. This is a HIG-approved style, not a
// cosmetic preference, so it is pinned.
test("uses the WHITE style and the theme's corner radius", async () => {
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  const button = getByLabelText("Sign in with Apple");
  expect(button.props.buttonStyle).toBe(0); // WHITE
  expect(button.props.buttonType).toBe(0); // SIGN_IN
  expect(button.props.cornerRadius).toBe(radius.lg);
});

test("calls onPress when tapped", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={onPress} />,
  );
  fireEvent.press(getByLabelText("Sign in with Apple"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("does not call onPress while disabled", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={onPress} disabled />,
  );
  fireEvent.press(getByLabelText("Sign in with Apple"));
  expect(onPress).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the failing Android test**

Create `apps/mobile/src/components/auth/__tests__/AppleSignInButton.android.test.tsx`.

**The Platform patching below is the only form that works in this project.** `jest.mock("react-native/Libraries/Utilities/Platform", …)` replaces the whole module and crashes the entire suite before any test runs — expo-modules-core's own `Platform.ts`, required lazily off a `global.fetch` getter installed by jest-expo's setupFiles, imports the same module and expects more than `{OS, select}`. Patch the two properties on the real singleton instead.

```tsx
import { render } from "@testing-library/react-native";
import { Platform } from "react-native";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";

const originalOS = Platform.OS;
const originalSelect = Platform.select;

beforeAll(() => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  Platform.select = ((specifics: Record<string, unknown>) => specifics.android) as typeof Platform.select;
});

afterAll(() => {
  Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  Platform.select = originalSelect;
});

jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});

// The iOS suite proves this component renders at all. Here the same props must
// produce nothing — a disappearance, not a component that never worked. The
// iOS-only guarantee is structural: a third call site cannot forget the guard
// the way LinkAccountPrompt originally did.
test("renders nothing on Android", async () => {
  const { queryByLabelText, toJSON } = await render(
    <AppleSignInButton accessibilityLabel="Sign in with Apple" onPress={jest.fn()} />,
  );
  expect(queryByLabelText("Sign in with Apple")).toBeNull();
  expect(toJSON()).toBeNull();
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/AppleSignInButton --ci`
Expected: FAIL — `Cannot find module '@/components/auth/AppleSignInButton'`.

- [ ] **Step 4: Write minimal implementation**

Create `apps/mobile/src/components/auth/AppleSignInButton.tsx`:

```tsx
import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import { useTheme } from "@/theme";

export interface AppleSignInButtonProps {
  onPress: () => void;
  // Required: the native button renders Apple's own text, so the accessible
  // name is the only place a caller can say "…to link" (LinkAccountPrompt).
  accessibilityLabel: string;
  disabled?: boolean;
}

// Apple's own button, which renders their mark and enforces their approved
// styles. Rendering a bespoke button with Kora's green is a routine App Store
// rejection under the HIG — on the very feature added for Guideline 4.8.
//
// Returns null off iOS, so the iOS-only guarantee is STRUCTURAL rather than a
// call-site convention. LinkAccountPrompt originally forgot its own
// Platform.OS check and shipped an Android control backed by an API that isn't
// there; a component that cannot render on Android makes the third call site's
// omission impossible rather than merely unlikely.
//
// AppleAuthentication.isAvailableAsync() is deliberately NOT used: it is async
// and would flash the button in and out on mount, and every device running
// Expo 57 is iOS 13+. An unprovisioned capability throws ERR_REQUEST_UNKNOWN,
// which firebaseAuthMessage already maps to the iCloud message.
export function AppleSignInButton({ onPress, accessibilityLabel, disabled }: AppleSignInButtonProps) {
  const { radius } = useTheme();

  if (Platform.OS !== "ios") return null;

  return (
    <AppleAuthentication.AppleAuthenticationButton
      accessibilityLabel={accessibilityLabel}
      buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
      // WHITE, not BLACK: the app's background is #0A0D0B, where a black
      // button with a black mark disappears.
      buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
      cornerRadius={radius.lg}
      style={{ height: 48 }}
      onPress={() => {
        if (disabled) return;
        onPress();
      }}
    />
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/AppleSignInButton --ci`
Expected: PASS — 4 tests in the iOS suite, 1 in the Android suite.

- [ ] **Step 6: Run the mutation**

Delete the `if (Platform.OS !== "ios") return null;` line.

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/AppleSignInButton --ci`
Expected: **exactly** `renders nothing on Android` FAILS. All four iOS tests must still PASS — if the iOS suite also goes red, the mutation broke rendering wholesale and proves nothing about the platform guard.

Revert the mutation before committing.

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/auth/AppleSignInButton.tsx \
        apps/mobile/src/components/auth/__tests__/AppleSignInButton.test.tsx \
        apps/mobile/src/components/auth/__tests__/AppleSignInButton.android.test.tsx
git commit -m "feat(mobile): add an Apple sign-in button that renders Apple's mark and cannot render on Android"
```

---

### Task 3: GoogleSignInButton

**Files:**
- Create: `apps/mobile/src/components/auth/GoogleSignInButton.tsx`
- Create: `apps/mobile/src/components/auth/__tests__/GoogleSignInButton.test.tsx`

**Interfaces:**
- Consumes: `PressableScale` from `@/motion`, `AppText` from `@/components/Text`, `Svg`/`Path` from `react-native-svg` (15.15.4, already a dependency).
- Produces: `GoogleSignInButton({ onPress, accessibilityLabel, title, disabled }: GoogleSignInButtonProps)`. `title` defaults to `"Sign in with Google"`.

Google's dark-theme branding spec is pinned: `#131314` fill, `#8E918F` hairline border, white label, full-colour G. These are **Google's** values, not theme tokens — they must not drift to `useTheme()`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/auth/__tests__/GoogleSignInButton.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

function styleOf(node: { props: { style: unknown } }) {
  const s = node.props.style;
  return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s;
}

test("renders the label and the G mark", async () => {
  const { getByLabelText, getByTestId, getByText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
  );
  expect(getByLabelText("Sign in with Google")).toBeTruthy();
  expect(getByText("Sign in with Google")).toBeTruthy();
  expect(getByTestId("google-g-mark")).toBeTruthy();
});

// Google's dark-theme branding spec. These are Google's values and must not be
// swapped for theme tokens, however tempting the consistency looks.
test("uses Google's dark-theme fill and hairline border", async () => {
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={jest.fn()} />,
  );
  const style = styleOf(getByLabelText("Sign in with Google"));
  expect(style.backgroundColor).toBe("#131314");
  expect(style.borderColor).toBe("#8E918F");
  expect(style.borderWidth).toBe(1);
});

test("renders a caller-supplied title", async () => {
  const { getByText } = await render(
    <GoogleSignInButton
      accessibilityLabel="Continue with Google to link"
      title="Continue with Google to link"
      onPress={jest.fn()}
    />,
  );
  expect(getByText("Continue with Google to link")).toBeTruthy();
});

test("calls onPress when tapped", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={onPress} />,
  );
  fireEvent.press(getByLabelText("Sign in with Google"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("does not call onPress while disabled", async () => {
  const onPress = jest.fn();
  const { getByLabelText } = await render(
    <GoogleSignInButton accessibilityLabel="Sign in with Google" onPress={onPress} disabled />,
  );
  fireEvent.press(getByLabelText("Sign in with Google"));
  expect(onPress).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/GoogleSignInButton.test.tsx --ci`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/components/auth/GoogleSignInButton.tsx`:

```tsx
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

// Google's dark-theme branding spec. NOT theme tokens: these are Google's
// values and changing them to match Kora's palette breaks the branding
// guidelines that permit using their mark at all.
const GOOGLE_DARK_FILL = "#131314";
const GOOGLE_DARK_BORDER = "#8E918F";
const GOOGLE_DARK_LABEL = "#E3E3E3";

export interface GoogleSignInButtonProps {
  onPress: () => void;
  accessibilityLabel: string;
  title?: string;
  disabled?: boolean;
}

// Custom rather than the library's GoogleSigninButton, which is fixed-style
// and does not match this app. The G is react-native-svg paths; using Google's
// asset inside a sign-in button is what their guidelines permit.
export function GoogleSignInButton({
  onPress,
  accessibilityLabel,
  title = "Sign in with Google",
  disabled,
}: GoogleSignInButtonProps) {
  const { radius, spacing } = useTheme();

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      haptic="selection"
      onPress={() => {
        if (disabled) return;
        onPress();
      }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.sm + 2,
        minHeight: 48,
        borderRadius: radius.lg,
        backgroundColor: GOOGLE_DARK_FILL,
        borderWidth: 1,
        borderColor: GOOGLE_DARK_BORDER,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <View testID="google-g-mark">
        <Svg width={18} height={18} viewBox="0 0 48 48">
          <Path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <Path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <Path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <Path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </Svg>
      </View>
      <AppText variant="headline" style={{ color: GOOGLE_DARK_LABEL }}>
        {title}
      </AppText>
    </PressableScale>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/GoogleSignInButton.test.tsx --ci`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the mutation**

Change `GOOGLE_DARK_FILL` to `colors.card` (import `colors` from `useTheme()` and use `colors.card`) — the exact drift the constant exists to prevent.

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/GoogleSignInButton.test.tsx --ci`
Expected: **exactly** `uses Google's dark-theme fill and hairline border` FAILS. The render, title, press and disabled tests must all still PASS.

Revert the mutation before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/auth/GoogleSignInButton.tsx \
        apps/mobile/src/components/auth/__tests__/GoogleSignInButton.test.tsx
git commit -m "feat(mobile): add a Google sign-in button following Google's dark-theme branding spec"
```

---

### Task 4: Field

**Files:**
- Create: `apps/mobile/src/components/Field.tsx`
- Create: `apps/mobile/src/components/__tests__/Field.test.tsx`

**Interfaces:**
- Produces: `Field(props: FieldProps)` where `FieldProps` extends `TextInputProps` with `label: string` and `error?: string`. The `accessibilityLabel` defaults to `label`, so existing `getByLabelText("Email")`-style queries keep working after Tasks 5 and 8 swap `TextInput` for `Field`.

The error slot exists on the component but **no screen uses it in this pass**. Sign-in keeps its single screen-level error; onboarding validates on submit as today. Introducing per-field errors would change validation behaviour, which this pass explicitly does not do.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/Field.test.tsx`:

```tsx
import { fireEvent, render } from "@testing-library/react-native";
import { Field } from "../Field";

test("renders a persistent label above the input", async () => {
  const { getByText, getByLabelText } = await render(
    <Field label="Email" value="" onChangeText={jest.fn()} />,
  );
  expect(getByText("Email")).toBeTruthy();
  expect(getByLabelText("Email")).toBeTruthy();
});

// The whole point of replacing placeholder-as-label: the label survives typing.
test("the label stays visible once the field has a value", async () => {
  const { getByText } = await render(
    <Field label="Email" value="sam@example.com" onChangeText={jest.fn()} />,
  );
  expect(getByText("Email")).toBeTruthy();
});

test("forwards text changes", async () => {
  const onChangeText = jest.fn();
  const { getByLabelText } = await render(
    <Field label="Email" value="" onChangeText={onChangeText} />,
  );
  fireEvent.changeText(getByLabelText("Email"), "sam@example.com");
  expect(onChangeText).toHaveBeenCalledWith("sam@example.com");
});

test("forwards TextInput props such as keyboardType and secureTextEntry", async () => {
  const { getByLabelText } = await render(
    <Field label="Password" value="" onChangeText={jest.fn()} secureTextEntry keyboardType="number-pad" />,
  );
  const input = getByLabelText("Password");
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.keyboardType).toBe("number-pad");
});

test("an explicit accessibilityLabel overrides the label", async () => {
  const { getByLabelText } = await render(
    <Field label="Weight" accessibilityLabel="Weight in kilograms" value="" onChangeText={jest.fn()} />,
  );
  expect(getByLabelText("Weight in kilograms")).toBeTruthy();
});

// Assert the presence first, so the absence below is a disappearance rather
// than a slot that never renders under any input.
test("renders the error slot only when an error is supplied", async () => {
  const withError = await render(
    <Field label="Email" error="That email looks wrong." value="" onChangeText={jest.fn()} />,
  );
  expect(withError.getByText("That email looks wrong.")).toBeTruthy();

  const withoutError = await render(<Field label="Email" value="" onChangeText={jest.fn()} />);
  expect(withoutError.queryByTestId("field-error")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/components/__tests__/Field.test.tsx --ci`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/components/Field.tsx`:

```tsx
import { TextInput, View, type TextInputProps } from "react-native";
import { AppText } from "./Text";
import { Card } from "./Card";
import { useTheme } from "@/theme";

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string;
}

// A labelled input: persistent label above, input below, optional error slot
// beneath. Replaces the placeholder-as-label pattern across the auth flow —
// placeholder-only inputs lose their label the moment the user types, so
// anyone who pauses mid-form loses context, and screen readers get a
// placeholder where a label belongs.
//
// The error slot is deliberately unused by every screen in this pass: sign-in
// keeps a single screen-level error and onboarding validates on submit.
// Wiring per-field errors would change validation behaviour.
export function Field({ label, error, accessibilityLabel, style, ...inputProps }: FieldProps) {
  const { colors, spacing, fontSize } = useTheme();

  return (
    <View style={{ gap: 6 }}>
      <AppText variant="footnote" muted>
        {label}
      </AppText>

      <Card variant="elevated" style={{ padding: 0 }}>
        <TextInput
          accessibilityLabel={accessibilityLabel ?? label}
          placeholderTextColor={colors.secondaryLabel}
          style={[
            {
              paddingHorizontal: spacing.md,
              paddingVertical: 12,
              color: colors.label,
              fontSize: fontSize.base,
              minHeight: 48,
            },
            style,
          ]}
          {...inputProps}
        />
      </Card>

      {error ? (
        <AppText
          testID="field-error"
          variant="footnote"
          accessibilityLiveRegion="polite"
          style={{ color: colors.destructive }}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/components/__tests__/Field.test.tsx --ci`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the mutation**

Change `accessibilityLabel={accessibilityLabel ?? label}` to `accessibilityLabel={label}` — silently ignoring an explicit override.

Run: `cd apps/mobile && npx jest src/components/__tests__/Field.test.tsx --ci`
Expected: **exactly** `an explicit accessibilityLabel overrides the label` FAILS. The other five must still PASS. This matters because Task 8's weight input relies on the override to keep its unit-specific accessible name.

Revert the mutation before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/Field.tsx apps/mobile/src/components/__tests__/Field.test.tsx
git commit -m "feat(mobile): add a labelled Field input to replace placeholder-as-label"
```

---

### Task 5: Sign-in screen

Social-first first paint; email revealed on demand; `Segmented` removed; mode moves to the footer link.

**Files:**
- Modify: `apps/mobile/app/sign-in.tsx`
- Modify: `apps/mobile/app/__tests__/sign-in-social.test.tsx`
- Test: `apps/mobile/app/__tests__/sign-in.test.tsx` (read it first; update any assertion that depends on the removed `Segmented` or on email fields being present at first paint)

**Interfaces:**
- Consumes: `BrandLockup` (Task 1), `AppleSignInButton` (Task 2), `GoogleSignInButton` (Task 3), `Field` (Task 4).
- Produces: no exports beyond the default screen.

**Behavioural contract that must not change:** `submit()`, `runSocial()`, `signInApple()`, `signInGoogle()` keep their current bodies. `firebaseAuthMessage` calls keep their `{ method, provider }` tagging. The `pendingLink` → `LinkAccountPrompt` wiring is untouched.

- [ ] **Step 1: Read the existing suites**

Run: `cd apps/mobile && cat app/__tests__/sign-in.test.tsx && cat app/__tests__/sign-in-social.test.tsx`

Note every assertion that will break:
- `getByLabelText("Continue with Apple")` → becomes `"Sign in with Apple"`.
- `getByLabelText("Continue with Google")` → becomes `"Sign in with Google"`.
- Anything asserting Email/Password inputs at first paint — they are now behind "Use email instead".
- Anything driving the `Segmented` mode control — mode now lives in the footer link.

- [ ] **Step 2: Write the failing tests**

Append to `apps/mobile/app/__tests__/sign-in-social.test.tsx`. It already mocks `expo-router`, `@/lib/firebase`, `firebase/auth`, `@/api/hooks`, `@/auth/socialCredentials` and `@/lib/socialAuth` — reuse them. Add the Apple-button mock alongside the existing ones at the top of the file:

```tsx
jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});
```

Then add:

```tsx
describe("sign-in first paint", () => {
  it("shows both provider buttons and no email fields", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
    expect(getByLabelText("Sign in with Google")).toBeTruthy();
    // The reveal is the behaviour: absent now, present after the tap below.
    expect(queryByLabelText("Email")).toBeNull();
    expect(queryByLabelText("Password")).toBeNull();
  });

  it("reveals the email form in place when 'Use email instead' is pressed", async () => {
    const { getByText, getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();

    await act(async () => {
      fireEvent.press(getByText("Use email instead"));
    });

    expect(getByLabelText("Email")).toBeTruthy();
    expect(getByLabelText("Password")).toBeTruthy();
    expect(getByLabelText("Sign in")).toBeTruthy();
    // The provider buttons stay visible — the form joins them, not replaces them.
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
  });

  it("no longer renders the ambiguous Sign in / Create account segmented control", async () => {
    const { getByLabelText, queryAllByRole } = await render(<SignIn />);
    // Presence first: the screen rendered.
    expect(getByLabelText("Sign in with Google")).toBeTruthy();
    // Segmented renders each option with accessibilityRole="tab"
    // (src/components/Segmented.tsx:61) and carries no testID. Role is the
    // unambiguous discriminator here: the new footer link reuses the strings
    // "Sign in" and "Create an account", so a label-based assertion would be
    // satisfied by the very control that replaced it.
    expect(queryAllByRole("tab")).toHaveLength(0);
  });
});

describe("sign-in mode toggle", () => {
  it("flips heading, CTA and footer link together", async () => {
    const { getByText, queryByText } = await render(<SignIn />);
    expect(getByText("Welcome back.")).toBeTruthy();
    expect(getByText("Create an account")).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByText("Create an account"));
    });

    expect(getByText("Start with Kora.")).toBeTruthy();
    expect(getByText("Sign in")).toBeTruthy();
    expect(queryByText("Welcome back.")).toBeNull();
  });
});
```

Do not add a testID to `Segmented` for this assertion — the component is being removed from this screen, not changed, and it is still used elsewhere in the app.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/mobile && npx jest app/__tests__/sign-in-social.test.tsx --ci`
Expected: FAIL — the new tests cannot find "Sign in with Apple" / "Use email instead"; several pre-existing tests fail on the renamed labels.

- [ ] **Step 4: Rewrite the screen body**

In `apps/mobile/app/sign-in.tsx`:

Replace the imports of `Segmented`, `Card` and `TextInput` usage with the new components. Delete `MODE_OPTIONS` and the `filledInputStyle` constant. Add `const [showEmail, setShowEmail] = useState(false);` beside the other state.

Replace everything from `<AuthScaffold` down to its closing tag with:

```tsx
      <AuthScaffold
        footer={
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
            <AppText muted variant="footnote">
              {mode === "in" ? "New here?" : "Already have an account?"}
            </AppText>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={mode === "in" ? "Create an account" : "Sign in"}
              haptic="selection"
              hitSlop={12}
              onPress={() => {
                setMode(mode === "in" ? "up" : "in");
                // An error raised by the other mode no longer applies, and would
                // read as a failure of the action just switched to.
                setError(null);
              }}
            >
              <AppText variant="footnote" style={{ color: colors.primary, fontWeight: "600" }}>
                {mode === "in" ? "Create an account" : "Sign in"}
              </AppText>
            </PressableScale>
          </View>
        }
      >
        <BrandLockup />
        <AppText variant="title1" style={{ marginTop: spacing.sm }}>
          {mode === "in" ? "Welcome back." : "Start with Kora."}
        </AppText>
        <AppText muted>
          {mode === "in"
            ? "Sign in to pick up where you left off."
            : "Create an account and log your first meal in seconds."}
        </AppText>

        <View style={{ gap: spacing.sm }}>
          <AppleSignInButton
            accessibilityLabel="Sign in with Apple"
            disabled={busy}
            onPress={signInApple}
          />
          {googleConfigured ? (
            <GoogleSignInButton
              accessibilityLabel="Sign in with Google"
              disabled={busy}
              onPress={signInGoogle}
            />
          ) : null}
        </View>

        {showEmail ? (
          <View style={{ gap: spacing.sm }}>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              textContentType={mode === "in" ? "password" : "newPassword"}
            />
            {/* The submit sits next to its own fields. AuthScaffold's sticky
                footer no longer carries it, which is what fixes the stranded
                primary action. */}
            <Button
              testID="auth-submit"
              accessibilityLabel={cta}
              title={busy ? "…" : cta}
              icon="arrow-right"
              iconPosition="trailing"
              onPress={submit}
              disabled={busy}
            />
          </View>
        ) : (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Use email instead"
            haptic="selection"
            hitSlop={12}
            onPress={() => setShowEmail(true)}
            style={{ alignItems: "center", paddingVertical: spacing.sm }}
          >
            <AppText variant="footnote" style={{ color: colors.primary, fontWeight: "600" }}>
              Use email instead
            </AppText>
          </PressableScale>
        )}

        {error ? (
          <AppText
            variant="footnote"
            accessibilityLiveRegion="polite"
            style={{ color: colors.destructive }}
          >
            {error}
          </AppText>
        ) : null}

        {pendingLink ? (
          <LinkAccountPrompt
            visible
            email={pendingLink.email}
            provider={pendingLink.provider}
            pendingCredential={pendingLink.pendingCredential as AuthCredential}
            onCancel={() => setPendingLink(null)}
            onLinked={() => {
              setPendingLink(null);
              router.replace("/");
            }}
          />
        ) : null}
      </AuthScaffold>
```

Add the imports this needs: `import { PressableScale } from "@/motion";`, `import { Field } from "@/components/Field";`, `import { AppleSignInButton } from "@/components/auth/AppleSignInButton";`, `import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";`. Remove now-unused imports (`Segmented`, `Card`, `TextInput`) — `tsc` and lint will both flag them.

**Note the Apple button no longer needs a `Platform.OS === "ios"` call-site guard** — it returns `null` off iOS itself. Leave the guard out here; that structural guarantee is the point of Task 2.

- [ ] **Step 5: Update the pre-existing assertions**

In both `app/__tests__/sign-in.test.tsx` and `app/__tests__/sign-in-social.test.tsx`, update:
- `"Continue with Apple"` → `"Sign in with Apple"`
- `"Continue with Google"` → `"Sign in with Google"`
- Any test that types into Email/Password must first press "Use email instead" inside `act`.
- Any test driving `Segmented` for mode must press the footer link instead.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/sign-in.test.tsx app/__tests__/sign-in-social.test.tsx --ci`
Expected: PASS, all suites.

- [ ] **Step 7: Run the mutation**

Change `const [showEmail, setShowEmail] = useState(false);` to `useState(true)` — the fields render at first paint.

Run: `cd apps/mobile && npx jest app/__tests__/sign-in-social.test.tsx --ci`
Expected: **exactly** `shows both provider buttons and no email fields` FAILS. `reveals the email form in place…` must still PASS (its post-press assertions hold), and every social sign-in test must still PASS. If the whole suite reddens, the mutation is too broad.

Revert the mutation before committing.

- [ ] **Step 8: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/app/sign-in.tsx apps/mobile/app/__tests__/sign-in.test.tsx apps/mobile/app/__tests__/sign-in-social.test.tsx
git commit -m "feat(mobile): lead sign-in with branded providers and reveal the email form on demand"
```

---

### Task 6: The entry gate

The redirect effect becomes a render gate. This is the defect that strands a new user in an empty tabs shell with no onboarding and no way out.

**Files:**
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Create: `apps/mobile/app/__tests__/tabs-layout.test.tsx`

**Interfaces:**
- Consumes: `BrandMark` (Task 1), `useProfile()` from `@/api/hooks` (a `useQuery`, so `{ data, isLoading, isError, error, refetch }`), `ApiError` from `@/lib/api`.

**The 401 rule.** `src/lib/api.ts` retries once on a 401; if the retry also 401s it sets the expired notice, calls `signOut`, and **still throws `ApiError(401)`**. So `isError` goes true at the same moment a redirect to `/sign-in?reason=expired` is in flight. Rendering "Couldn't load your profile" with a Retry there is wrong and misleadingly actionable — Retry cannot succeed, the session is gone.

**Do NOT discriminate using `takeSessionExpiredNotice()`.** It is a one-shot the sign-out effect consumes to attach `reason=expired`; reading it from the gate steals the flag and silently turns "your session expired" into an unexplained bounce. Discriminate on `error instanceof ApiError && error.status === 401`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/tabs-layout.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { router } from "expo-router";
import TabsLayout from "../(tabs)/_layout";
import { ApiError } from "@/lib/api";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  Tabs: Object.assign(
    ({ children }: { children: React.ReactNode }) => {
      const { View } = require("react-native");
      return <View testID="tabs">{children}</View>;
    },
    { Screen: () => null },
  ),
}));
jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));
jest.mock("@/lib/push", () => ({ usePushRegistration: jest.fn(), usePushResponder: jest.fn() }));
jest.mock("@/components/FloatingTabBar", () => ({ FloatingTabBar: () => null }));

const mockUseProfile = jest.fn();
jest.mock("@/api/hooks", () => ({ useProfile: () => mockUseProfile() }));

const LOADING = { data: undefined, isLoading: true, isError: false, error: null, refetch: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders the branded splash and NOT the tabs while the profile loads", async () => {
  mockUseProfile.mockReturnValue(LOADING);
  const { getByTestId, queryByTestId } = await render(<TabsLayout />);
  expect(getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(queryByTestId("tabs")).toBeNull();
});

test("renders the tabs once an onboarded profile resolves", async () => {
  mockUseProfile.mockReturnValue({
    data: { onboarded_at: "2026-01-01T00:00:00Z" },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  });
  const { getByTestId } = await render(<TabsLayout />);
  expect(getByTestId("tabs")).toBeTruthy();
});

test("routes a never-onboarded profile to onboarding instead of the tabs", async () => {
  mockUseProfile.mockReturnValue({
    data: { onboarded_at: null },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  });
  const { queryByTestId } = await render(<TabsLayout />);
  expect(router.replace).toHaveBeenCalledWith("/onboarding");
  expect(queryByTestId("tabs")).toBeNull();
});

// The state that currently strands people silently.
test("renders a retry on a non-401 failure, and not the tabs", async () => {
  const refetch = jest.fn();
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(500, "server_error", "boom", "req-1"),
    refetch,
  });
  const { getByLabelText, queryByTestId } = await render(<TabsLayout />);
  expect(getByLabelText("Retry")).toBeTruthy();
  expect(queryByTestId("tabs")).toBeNull();
});

// A 401 means api.ts has already forced a sign-out and a redirect to
// /sign-in?reason=expired is in flight. Retry cannot succeed. The test above
// establishes that Retry DOES render for a non-401 error, so its absence here
// is a disappearance rather than a control that never rendered.
test("a 401 renders the splash, not the retry", async () => {
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(401, "unauthorized", "expired", "req-2"),
    refetch: jest.fn(),
  });
  const { getByTestId, queryByLabelText, queryByTestId } = await render(<TabsLayout />);
  expect(getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(queryByLabelText("Retry")).toBeNull();
  expect(queryByTestId("tabs")).toBeNull();
});

// Consuming the one-shot here would strip `reason=expired` off the sign-in
// screen, turning an explained expiry into an unexplained bounce.
test("does not consume the session-expired notice", async () => {
  const api = require("@/lib/api");
  const spy = jest.spyOn(api, "takeSessionExpiredNotice");
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(401, "unauthorized", "expired", "req-3"),
    refetch: jest.fn(),
  });
  await render(<TabsLayout />);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
```

> The `expo-router` mock above must expose `Tabs.Screen`, since the layout renders four of them. If `ApiError`'s constructor arity differs from `(status, error, message, requestId)`, read `src/lib/api.ts:6-12` and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/tabs-layout.test.tsx --ci`
Expected: FAIL — the splash, retry and 401 cases do not exist; the loading case renders `<Tabs>` today.

- [ ] **Step 3: Write the implementation**

In `apps/mobile/app/(tabs)/_layout.tsx`, delete the `useEffect` at lines 34-36 and replace the `return (` block. Keep the `onAuthStateChanged` sign-out effect exactly as it is.

```tsx
  // Resolved BEFORE <Tabs> renders. The old code redirected from an effect that
  // fired only once profile.data existed, which produced two defects: a flash
  // of empty app while GET /v1/me was in flight, and — if the request failed —
  // a user sitting in an empty tabs shell with no onboarding and no way out.
  // #108 widened that hole: one tap now creates an account.
  //
  // TabsLayout is the right chokepoint because every entry path crosses it —
  // fresh sign-in AND cold start with an existing session. Routing from
  // sign-in.tsx instead would miss relaunches entirely.
  if (profile.isLoading) return <Splash />;

  if (profile.isError) {
    // A 401 means api.ts already forced a sign-out and the onAuthStateChanged
    // effect above is redirecting to /sign-in?reason=expired. Offering "Retry"
    // here would be misleadingly actionable: the session is gone.
    //
    // Discriminated on status, NOT on takeSessionExpiredNotice() — that is a
    // one-shot the sign-out effect consumes to attach `reason=expired`, and
    // reading it here would silently drop the explanation.
    if (profile.error instanceof ApiError && profile.error.status === 401) return <Splash />;

    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
        }}
      >
        <BrandMark size={48} />
        <AppText variant="title2">Couldn&apos;t load your profile</AppText>
        <AppText muted style={{ textAlign: "center" }}>
          Check your connection and try again.
        </AppText>
        <Button
          accessibilityLabel="Retry"
          title="Retry"
          onPress={() => {
            void profile.refetch();
          }}
        />
      </View>
    );
  }

  if (profile.data && profile.data.onboarded_at === null) {
    router.replace("/onboarding");
    return <Splash />;
  }

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

// Not a spinner over an empty app: the app genuinely has not started yet, and
// the splash says so honestly.
function Splash() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <BrandMark size={64} />
    </View>
  );
}
```

Add imports: `import { View } from "react-native";`, `import { ApiError } from "@/lib/api";` (extend the existing `@/lib/api` import), `import { BrandMark } from "@/components/BrandMark";`, `import { AppText } from "@/components/Text";`, `import { Button } from "@/components/Button";`. Pull `spacing` out of `useTheme()` alongside `colors`.

> `router.replace` during render is what the current code already does inside an effect; calling it here plus returning `<Splash />` keeps the tabs from mounting at all. If React warns about navigating during render in this expo-router version, move the `replace` into a `useEffect` that depends on `profile.data?.onboarded_at` and keep returning `<Splash />` from the render path — the assertion in the test (`router.replace` called, tabs not rendered) holds either way.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest app/__tests__/tabs-layout.test.tsx --ci`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the mutation**

Delete the 401 branch — the line `if (profile.error instanceof ApiError && profile.error.status === 401) return <Splash />;`.

Run: `cd apps/mobile && npx jest app/__tests__/tabs-layout.test.tsx --ci`
Expected: **exactly** `a 401 renders the splash, not the retry` FAILS. `renders a retry on a non-401 failure` must still PASS — that pairing is what proves the discriminator works rather than the error branch being unreachable.

Revert, then run a second mutation: change the discriminator to `takeSessionExpiredNotice()`.
Expected: `does not consume the session-expired notice` FAILS.

Revert both before committing.

- [ ] **Step 6: Run the full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: green.

- [ ] **Step 7: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add "apps/mobile/app/(tabs)/_layout.tsx" apps/mobile/app/__tests__/tabs-layout.test.tsx
git commit -m "fix(mobile): gate the tabs on a resolved profile so a new or offline user is never stranded"
```

---

### Task 7: The link prompt

Copy and presentation only. **`src/auth/link.ts` is untouched** — the handshake, the fail-open logic and the `showPassword`/`showGoogle`/`showApple` derivation all keep their current behaviour.

Enumeration protection is **on** for this project (`enableImprovedEmailPrivacy: true`), so `existingSignInMethods` returns `[]` and the fail-open branch is the **live** path, not a rare fallback. The prompt will normally offer every method rather than naming the right one — so the copy must present a choice, not a diagnosis.

**Files:**
- Modify: `apps/mobile/src/components/auth/LinkAccountPrompt.tsx`
- Modify: `apps/mobile/src/components/auth/__tests__/LinkAccountPrompt.test.tsx`
- Modify: `apps/mobile/src/components/auth/__tests__/LinkAccountPrompt.android.test.tsx`

**Interfaces:**
- Consumes: `AppleSignInButton` (Task 2), `GoogleSignInButton` (Task 3).
- The accessible names **stay** `"Continue with Apple to link"` and `"Continue with Google to link"`, so the existing Android test keeps working. The native Apple button renders Apple's own text; only its `accessibilityLabel` can carry "to link".

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/src/components/auth/__tests__/LinkAccountPrompt.test.tsx` (reuse its existing mocks; add the `expo-apple-authentication` mock from Task 2 Step 1):

```tsx
describe("link prompt copy", () => {
  it("leads with what happened, naming the email, and does not read as an error", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { findByText } = await render(
      <LinkAccountPrompt
        visible
        email="sam@example.com"
        provider="apple.com"
        pendingCredential={pending}
        onCancel={jest.fn()}
        onLinked={jest.fn()}
      />,
    );
    expect(await findByText(/You already have a Kora account for sam@example.com/)).toBeTruthy();
  });

  it("states that linking is one-time", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { findByText } = await render(
      <LinkAccountPrompt
        visible
        email="sam@example.com"
        provider="apple.com"
        pendingCredential={pending}
        onCancel={jest.fn()}
        onLinked={jest.fn()}
      />,
    );
    expect(await findByText(/Once connected, either one will sign you in/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/LinkAccountPrompt.test.tsx --ci`
Expected: FAIL — the current copy is "An account already exists for …".

- [ ] **Step 3: Write the implementation**

In `LinkAccountPrompt.tsx`, replace the heading and body block:

```tsx
          <AppText variant="title2">Connect {PROVIDER_LABEL[provider]}</AppText>
          <AppText muted>
            You already have a Kora account for {email}. Sign in once to connect{" "}
            {PROVIDER_LABEL[provider]}. Once connected, either one will sign you in.
          </AppText>
```

Swap the two provider `Button`s for the branded components, keeping their `onPress` bodies byte-for-byte:

```tsx
          {showGoogle ? (
            <GoogleSignInButton
              accessibilityLabel="Continue with Google to link"
              title="Continue with Google to link"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    configureGoogleSignin();
                    const idToken = await signInWithGoogleNative();
                    await completeLinkWithGoogle(idToken, pendingCredential);
                  },
                  { method: "social", provider: "google.com" },
                )
              }
            />
          ) : null}

          {showApple ? (
            <AppleSignInButton
              accessibilityLabel="Continue with Apple to link"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    const { idToken, rawNonce, authorizationCode } = await signInWithAppleNative();
                    await completeLinkWithApple(idToken, rawNonce, pendingCredential);
                    // Non-fatal, same reasoning as the sign-in path
                    // (socialCredentials.ts): a failed capture must never undo a
                    // link that already succeeded. Without this call, this fresh
                    // code — the only one this flow will ever see — is fetched
                    // from Apple and discarded, leaving the user unrevokable
                    // until their next Apple sign-in.
                    if (authorizationCode) {
                      try {
                        await storeAppleAuthorization(authorizationCode);
                      } catch {
                        // Swallowed deliberately; the link itself already succeeded.
                      }
                    }
                  },
                  { method: "social", provider: "apple.com" },
                )
              }
            />
          ) : null}
```

Add the two imports; remove `Button` only if nothing else uses it (the Cancel and "Sign in and link" buttons still do — keep it).

**Leave `showApple`'s `Platform.OS === "ios"` guard in place.** It is now belt-and-braces behind `AppleSignInButton`'s structural guarantee, and the Android test asserts the outcome either way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/ --ci`
Expected: PASS, both suites including the Android one.

- [ ] **Step 5: Run the mutation**

In `LinkAccountPrompt.tsx`, remove `{email}` from the body copy.

Run: `cd apps/mobile && npx jest src/components/auth/__tests__/LinkAccountPrompt.test.tsx --ci`
Expected: **exactly** `leads with what happened, naming the email…` FAILS. The one-time-copy test and every pre-existing fail-open test must still PASS.

Revert the mutation before committing.

- [ ] **Step 6: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/src/components/auth/LinkAccountPrompt.tsx apps/mobile/src/components/auth/__tests__/
git commit -m "feat(mobile): reframe the link prompt as a merge and adopt the branded provider buttons"
```

---

### Task 8: Onboarding

A sharpening pass. Steps, copy, goal cards and progress dots are unchanged.

**Files:**
- Modify: `apps/mobile/app/onboarding.tsx` (the five `TextInput`s at lines ~191-248)
- Modify: `apps/mobile/app/__tests__/onboarding.test.tsx` (the only onboarding suite)

**Interfaces:**
- Consumes: `Field` (Task 4). `BrandLockup` on step 1 picks up `BrandMark` automatically from Task 1 — no call-site change.

**Accessible names must not change**, or the existing onboarding suites break: `"Birth year"`, `"Height in feet"`, `"Height in inches"`, `"Height in centimetres"`, and the weight input's unit-dependent `"Weight in pounds"` / `"Weight in kilograms"`. The weight field is exactly why `Field` supports an `accessibilityLabel` override (Task 4).

- [ ] **Step 1: Read the existing suite**

The only onboarding suite is `apps/mobile/app/__tests__/onboarding.test.tsx`. Read it. Two things matter:

- It already asserts every accessible name this task must preserve: `"Birth year"`, `"Height in centimetres"`, `"Height in feet"`, `"Height in inches"`, `"Weight in kilograms"`, `"Weight in pounds"` (lines 110-112, 179-181, 211-214, 235-237). **That existing coverage is the regression net for this task** — if any name drifts, those tests go red.
- Line 56 asserts `queryByLabelText("Birth year")` is `null` on **step 1**. `Field` must not leak the label outside step 2.
- It reaches step 2 via the local helper `advance(ui)` (line 41), which presses "Continue". `mockUseUnits` is set to `{ system: "metric" }` in `beforeEach` (line 37).

- [ ] **Step 2: Write the failing test**

Append to `apps/mobile/app/__tests__/onboarding.test.tsx`, reusing its existing mocks and the `advance` helper:

```tsx
// The point of Field: the label is real text above the input, so it survives
// typing. A placeholder-only input loses it the moment the user types.
test("step 2's inputs carry persistent labels, not just placeholders", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);

  expect(ui.getByText("Birth year")).toBeTruthy();
  expect(ui.getByText("Height (cm)")).toBeTruthy();
  expect(ui.getByText("Weight (kg)")).toBeTruthy();
});

test("the labels survive typing", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);

  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");

  expect(ui.getByText("Birth year")).toBeTruthy();
  expect(ui.getByLabelText("Birth year").props.value).toBe("1995");
});

// The weight field's visible label is unit-shorthand while its accessible name
// spells the unit out. That divergence is exactly why Field takes an
// accessibilityLabel override.
test("the weight field keeps its unit-specific accessible name", async () => {
  const ui = await render(<Onboarding />);
  await advance(ui);

  expect(ui.getByLabelText("Weight in kilograms")).toBeTruthy();
  expect(ui.getByText("Weight (kg)")).toBeTruthy();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/onboarding --ci`
Expected: FAIL — `getByText("Birth year")` finds nothing; today the string exists only as the placeholder `"Birth year (e.g. 1995)"`.

- [ ] **Step 4: Write the implementation**

Replace each of the five `TextInput`s. Birth year:

```tsx
          <Field
            label="Birth year"
            placeholder="e.g. 1995"
            keyboardType="number-pad"
            value={birthYear}
            onChangeText={setBirthYear}
          />
```

Height (imperial), grouped so they read as one question:

```tsx
            <Field label="Height (ft)" accessibilityLabel="Height in feet" keyboardType="number-pad" value={heightFt} onChangeText={setHeightFt} />
            <Field label="Height (in)" accessibilityLabel="Height in inches" keyboardType="number-pad" value={heightIn} onChangeText={setHeightIn} />
```

Height (metric):

```tsx
            <Field label="Height (cm)" accessibilityLabel="Height in centimetres" keyboardType="decimal-pad" value={heightCm} onChangeText={setHeightCm} />
```

Weight — the override is load-bearing:

```tsx
          <Field
            label={system === "imperial" ? "Weight (lb)" : "Weight (kg)"}
            accessibilityLabel={system === "imperial" ? "Weight in pounds" : "Weight in kilograms"}
            keyboardType="decimal-pad"
            value={weightText}
            onChangeText={setWeightText}
          />
```

Wrap the three questions in a container with `gap: spacing.md` so they group. Remove the now-unused `filledInputStyle` and any `Card` import left dangling.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest app/__tests__/onboarding --ci`
Expected: PASS.

- [ ] **Step 6: Run the mutation**

Drop the `accessibilityLabel` prop from the weight `Field`, leaving only `label`.

Run: `cd apps/mobile && npx jest app/__tests__/onboarding --ci`
Expected: **exactly** `the weight field keeps its unit-specific accessible name` (plus any pre-existing test querying `"Weight in kilograms"`) FAILS. The birth-year and height tests must still PASS.

Revert the mutation before committing.

- [ ] **Step 7: Run the full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: green.

- [ ] **Step 8: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/kora
git add apps/mobile/app/onboarding.tsx apps/mobile/app/__tests__/
git commit -m "feat(mobile): give onboarding's step-2 inputs persistent labels"
```

---

## Simulator verification

After Task 8, run the app and look at the four surfaces. The simulator settles layout, the reveal, the mode toggle and the entry gate.

```bash
cd apps/mobile && npx expo run:ios
```

Check:
1. Sign-in first paint: dot-grid lockup, two provider buttons, "Use email instead", footer link. Apple's button is white with Apple's mark; Google's is `#131314` with the colour G. **Green appears only on the text links** — if the loudest thing on screen is a provider button, something is wrong.
2. Press "Use email instead" — labelled fields and a green "Sign in →" appear in place, providers still visible.
3. Press "Create an account" — heading, CTA and footer link flip together.
4. Cold-start with an unonboarded account — branded splash, then onboarding. No flash of empty tabs.

## Still requires a physical device (out of scope for this plan)

The simulator does **not** settle:
1. Apple's native button rendering and sheet under real signing.
2. Whether enumeration protection changes which error surfaces on a real collision.

Both fold into the device pass already outstanding for #108 and #106, which is blocked on the iPhone being offline.

---

## Self-Review

**Spec coverage.** Every section maps to a task: `BrandMark` → 1; kit divergence (spec amendment) → 1 steps 7-8; `AppleSignInButton` → 2; `GoogleSignInButton` → 3; `Field` → 4; Sign-in incl. `Segmented` removal and mode-to-footer → 5; entry gate incl. the 401 rule (spec amendment) → 6; link prompt → 7; onboarding → 8. Spec's testing list is covered: Android disappearance (2), nine dots with positions (1), first paint absent-then-present (5), mode toggle (5), gate loading/error/null/resolved plus 401 (6), link-prompt copy naming the email (7), kit grep count (1).

**Out-of-scope items are respected:** no change to `socialCredentials.ts`, `link.ts`, `socialAuth.ts`, or `firebaseAuthMessage.ts` branching; no new aesthetic; partial onboarding not persisted; no server-side merging.

**Known follow-ups, deliberately not in this plan:** `Field`'s error slot ships unused (spec's explicit choice); `Segmented` remains in the codebase for other screens; the device pass stays blocked.

**Type consistency check.** `BrandMark({ size })` — used at 40 (Task 1), 48 and 64 (Task 6). `AppleSignInButton({ onPress, accessibilityLabel, disabled })` — `accessibilityLabel` required, passed as "Sign in with Apple" (Task 5) and "Continue with Apple to link" (Task 7). `GoogleSignInButton({ onPress, accessibilityLabel, title?, disabled })` — `title` defaulted in Task 3, overridden in Task 7. `FieldProps extends TextInputProps` with `label` required and `accessibilityLabel` falling back to `label` — the fallback is exercised in Task 5 and the override in Task 8, and Task 4's mutation pins it. `testID` names are stable: `brand-dot-${r}-${c}`, `google-g-mark`, `field-error`, `tabs`, `auth-submit`.
