# Kora Onboarding & Auth Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the pre-app flow (sign-in, create account, onboarding) up to the
`design-system/ui_kits/kora/Onboarding.jsx` mockup, split onboarding into two steps, and
replace the catch-all auth error with specific messages.

**Architecture:** Three new presentational components (`BrandLockup`, `SelectableCard`,
`AuthScaffold`) plus one pure helper (`firebaseAuthMessage`) are built and tested first.
`onboarding.tsx` then becomes a single route holding `step: 1 | 2` state — no new routes,
no cross-route state plumbing, and still exactly one `submit.mutate` call. `sign-in.tsx`
adopts the same scaffold and gains an explicit mode toggle.

**Tech Stack:** Expo SDK 57 / React Native, Expo Router, TypeScript, Jest +
`@testing-library/react-native`, `react-native-reanimated`, `expo-symbols`.

**Spec:** `docs/superpowers/specs/2026-08-01-kora-onboarding-auth-polish-design.md`

## Global Constraints

- Working directory for every command: `apps/mobile`. Worktree root:
  `/Users/Mahesh.Sangawar/personal/tesserix-new/kora-onboarding`, branch `kora-onboarding-polish`.
- Run tests with `npm test` (jest, `--ci --forceExit`). Run them in the **foreground** —
  never backgrounded.
- Typecheck with `npx tsc --noEmit`. Must be clean before every commit.
- **Read the versioned Expo docs before writing code:** https://docs.expo.dev/versions/v57.0.0/
  (`apps/mobile/AGENTS.md` mandates this — the API surface has changed).
- Never mutate objects in place; build new ones (spread) — repo-wide rule.
- Theme tokens only. `useTheme()` returns
  `{ colors, spacing, radius, fontSize, fonts, shadows, scheme, type, gradients }`.
  - `spacing`: `xs:4 sm:8 md:16 lg:24 xl:32 "2xl":48 "3xl":64`
  - `radius`: `sm:6 md:10 lg:12 xl:16 "2xl":24 "3xl":32 full:9999`
  - Colors used here: `primary`, `primaryForeground`, `accent`, `background`, `label`,
    `secondaryLabel`, `card`, `cardSecondary`, `elevated`, `border`, `destructive`.
- No hardcoded colours, radii or spacing values. No `console.log`.
- Under Jest, `expo-symbols`' `SymbolView` is mocked to render
  `testID={`sf-${symbolName}`}` — so on the iOS path the `check` icon is queryable as
  `sf-checkmark`, `sparkles` as `sf-sparkles`, `arrow-right` as `sf-arrow.right`.
- **The onboarding API contract does not change.** `OnboardingInput` keeps exactly the
  fields `sex`, `goal`, `activity_level`, `birth_year`, `height_cm`, `weight_kg`.
- Every new test must be mutation-checked: break the behaviour it covers, confirm the test
  fails, then restore. A test that passes against a control that never renders is not
  coverage.

---

### Task 1: Add the `sparkles` icon and trailing icon support to `Button`

Two small shared changes the later tasks depend on. `Icon` has a fixed allow-list and
`sparkles` is **absent**, so it currently falls back to a `Circle` — the brand mark would
silently render as a circle. `Button` renders its icon *before* the title, but the mockup's
CTA is `Get started` **then** `arrow-right`.

**Files:**
- Modify: `src/components/Icon.tsx`
- Modify: `src/components/Button.tsx`
- Test: `src/components/__tests__/Button.test.tsx` (create if absent)
- Test: `src/components/__tests__/Icon.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Icon` accepts `name="sparkles"`.
  - `Button` props gain `iconPosition?: "leading" | "trailing"` (default `"leading"`, so
    every existing call site is unchanged).

- [ ] **Step 1: Write the failing tests**

Create `src/components/__tests__/Icon.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { Icon } from "../Icon";

test("sparkles resolves to a real SF Symbol, not the Circle fallback", () => {
  const { queryByTestId } = render(<Icon name="sparkles" color="#000" />);
  // The expo-symbols mock renders testID `sf-<symbol>`. An unmapped name would
  // fall through to the lucide `Circle` and render no testID at all.
  expect(queryByTestId("sf-sparkles")).toBeTruthy();
});
```

Create `src/components/__tests__/Button.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { Button } from "../Button";

test("trailing icon renders after the title", () => {
  const { getByText, getByTestId } = render(
    <Button title="Get started" icon="arrow-right" iconPosition="trailing" onPress={() => {}} />,
  );
  const row = getByTestId("button-content");
  const children = row.props.children.filter(Boolean);
  // Title first, icon second.
  expect(children).toHaveLength(2);
  expect(getByText("Get started")).toBeTruthy();
  expect(getByTestId("sf-arrow.right")).toBeTruthy();
  expect(row.props.style.flexDirection).toBe("row");
});

test("leading icon remains the default so existing call sites are unchanged", () => {
  const { getByTestId } = render(<Button title="Go" icon="arrow-right" onPress={() => {}} />);
  expect(getByTestId("button-content")).toBeTruthy();
  expect(getByTestId("sf-arrow.right")).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/components/__tests__/Icon.test.tsx src/components/__tests__/Button.test.tsx`

Expected: FAIL. `Icon` test fails because `sf-sparkles` is null (name unmapped). `Button`
tests fail because `button-content` testID does not exist.

- [ ] **Step 3: Add `sparkles` to both icon maps**

In `src/components/Icon.tsx`, add `Sparkles` to the `lucide-react-native` import list:

```tsx
  Search, Trophy, Heart, Star, Bookmark, Sparkles,
```

Add to `SYMBOLS`:

```tsx
  "sparkles": "sparkles",
```

Add to `MAP`:

```tsx
  sparkles: Sparkles,
```

- [ ] **Step 4: Add `iconPosition` to `Button`**

In `src/components/Button.tsx`, extend the props type:

```tsx
type Props = Omit<PressableProps, "children" | "style"> & {
  title: string;
  variant?: Variant;
  icon?: string;
  iconPosition?: "leading" | "trailing";
  style?: StyleProp<ViewStyle>;
};
```

Update the signature and the icon branch:

```tsx
export function Button({
  title,
  variant = "primary",
  icon,
  iconPosition = "leading",
  disabled,
  style,
  onPress,
  ...rest
}: Props) {
```

Replace the `{icon ? (...) : (...)}` block with:

```tsx
      {icon ? (
        <View
          testID="button-content"
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {iconPosition === "leading" ? <Icon name={icon} size={18} color={fg} /> : null}
          <AppText variant="headline" style={{ color: fg }}>
            {title}
          </AppText>
          {iconPosition === "trailing" ? <Icon name={icon} size={18} color={fg} /> : null}
        </View>
      ) : (
        <AppText variant="headline" style={{ color: fg }}>
          {title}
        </AppText>
      )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/components/__tests__/Icon.test.tsx src/components/__tests__/Button.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Mutation-check**

Temporarily remove `sparkles: Sparkles,` and the `"sparkles": "sparkles",` entry — the Icon
test must FAIL. Restore. Temporarily force `iconPosition` to always render leading — the
trailing test must FAIL. Restore.

- [ ] **Step 7: Verify nothing else broke, then commit**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npm test` — expected: all suites pass (the default `iconPosition` keeps existing
`Button` call sites byte-identical in behaviour).

```bash
git add src/components/Icon.tsx src/components/Button.tsx src/components/__tests__/Icon.test.tsx src/components/__tests__/Button.test.tsx
git commit -m "feat(mobile): add the sparkles icon and a trailing icon slot on Button"
```

---

### Task 2: `BrandLockup` component

**Files:**
- Create: `src/components/BrandLockup.tsx`
- Test: `src/components/__tests__/BrandLockup.test.tsx`

**Interfaces:**
- Consumes: `Icon` with `name="sparkles"` (Task 1).
- Produces: `export function BrandLockup(): JSX.Element` — no props.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/BrandLockup.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { BrandLockup } from "../BrandLockup";

test("renders the Kora wordmark beside a sparkles mark", () => {
  const { getByText, getByTestId } = render(<BrandLockup />);
  expect(getByText("Kora")).toBeTruthy();
  expect(getByTestId("sf-sparkles")).toBeTruthy();
});

test("the mark is a filled tile, not a bare icon", () => {
  const { getByTestId } = render(<BrandLockup />);
  const tile = getByTestId("brand-mark-tile");
  expect(tile.props.style.width).toBe(40);
  expect(tile.props.style.height).toBe(40);
  // A background must be set from the theme; a bare icon would leave it undefined.
  expect(tile.props.style.backgroundColor).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/__tests__/BrandLockup.test.tsx`
Expected: FAIL — "Cannot find module '../BrandLockup'".

- [ ] **Step 3: Write the implementation**

Create `src/components/BrandLockup.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

// The Kora brand lockup from design-system/ui_kits/kora/Onboarding.jsx: a filled
// primary tile carrying the sparkles mark, beside the wordmark. Shown at the top
// of the pre-app screens (sign-in and onboarding step 1) so the flow is
// recognisably Kora before the user has an account.
export function BrandLockup() {
  const { colors, radius, shadows } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <View
        testID="brand-mark-tile"
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.lg,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
          ...shadows.md,
        }}
      >
        <Icon name="sparkles" size={22} color={colors.primaryForeground} />
      </View>
      <AppText variant="title2" style={{ letterSpacing: -0.4 }}>
        Kora
      </AppText>
    </View>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/__tests__/BrandLockup.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: clean.

```bash
git add src/components/BrandLockup.tsx src/components/__tests__/BrandLockup.test.tsx
git commit -m "feat(mobile): add the Kora brand lockup"
```

---

### Task 3: `SelectableCard` component

The mockup's goal card, generalised. Used for goals (with icon) and activity levels
(without) — see the spec's rationale for why activity omits the icon.

**Files:**
- Create: `src/components/SelectableCard.tsx`
- Test: `src/components/__tests__/SelectableCard.test.tsx`

**Interfaces:**
- Consumes: `Icon`, and `PressableScale` from `@/motion`.
- Produces:

```ts
type SelectableCardProps = {
  icon?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
};
export function SelectableCard(props: SelectableCardProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/SelectableCard.test.tsx`:

```tsx
import { render, fireEvent } from "@testing-library/react-native";
import { SelectableCard } from "../SelectableCard";

test("selected card exposes radio semantics and a checkmark", () => {
  const { getByRole, getByTestId } = render(
    <SelectableCard icon="trending-down" title="Lose weight" subtitle="Gentle calorie deficit" selected onPress={() => {}} />,
  );
  const card = getByRole("radio");
  expect(card.props.accessibilityState.selected).toBe(true);
  expect(getByTestId("sf-checkmark")).toBeTruthy();
});

test("unselected card reports selected:false and renders no checkmark", () => {
  const { getByRole, queryByTestId } = render(
    <SelectableCard title="Light" subtitle="1-2 sessions a week" selected={false} onPress={() => {}} />,
  );
  expect(getByRole("radio").props.accessibilityState.selected).toBe(false);
  expect(queryByTestId("sf-checkmark")).toBeNull();
});

test("pressing the card invokes onPress", () => {
  const onPress = jest.fn();
  const { getByRole } = render(
    <SelectableCard title="Maintain" selected={false} onPress={onPress} />,
  );
  fireEvent.press(getByRole("radio"));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("the icon tile is rendered only when an icon is supplied", () => {
  const withIcon = render(
    <SelectableCard icon="trending-up" title="Build muscle" selected={false} onPress={() => {}} />,
  );
  expect(withIcon.queryByTestId("selectable-icon-tile")).toBeTruthy();

  const withoutIcon = render(
    <SelectableCard title="Sedentary" selected={false} onPress={() => {}} />,
  );
  expect(withoutIcon.queryByTestId("selectable-icon-tile")).toBeNull();
});

test("the tap target clears the 44pt accessibility minimum", () => {
  const { getByRole } = render(
    <SelectableCard title="Active" selected={false} onPress={() => {}} />,
  );
  const style = getByRole("radio").props.style;
  const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
  expect(flat.minHeight).toBeGreaterThanOrEqual(44);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/__tests__/SelectableCard.test.tsx`
Expected: FAIL — "Cannot find module '../SelectableCard'".

- [ ] **Step 3: Write the implementation**

Create `src/components/SelectableCard.tsx`:

```tsx
import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  icon?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
};

// The selectable card from design-system/ui_kits/kora/Onboarding.jsx. Selection is
// carried by three signals at once — border, tile fill and the radio — because a
// single accent-coloured cue is easy to miss and fails for colour-blind users.
// `icon` is optional: the goal picker passes one, the activity list does not
// (five tiles would read as a wall, and the levels are distinguished by their
// descriptors).
//
// Built on PressableScale, which already gates its spring on useMotionPrefs —
// so the spec's reduced-motion requirement is inherited here. Do not add a
// second reduced-motion check.
export function SelectableCard({ icon, title, subtitle, selected, onPress }: Props) {
  const { colors, radius, spacing, shadows } = useTheme();

  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      haptic="selection"
      onPress={onPress}
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        padding: spacing.md,
        borderRadius: radius.xl,
        backgroundColor: colors.card,
        borderWidth: 2,
        borderColor: selected ? colors.primary : colors.border,
        ...(selected ? shadows.md : null),
      }}
    >
      {icon ? (
        <View
          testID="selectable-icon-tile"
          style={{
            width: 42,
            height: 42,
            borderRadius: radius.lg,
            backgroundColor: selected ? colors.primary : colors.cardSecondary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={20} color={selected ? colors.primaryForeground : colors.primary} />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        <AppText variant="headline">{title}</AppText>
        {subtitle ? (
          <AppText variant="footnote" muted>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: selected ? colors.primary : "transparent",
          borderWidth: selected ? 0 : 2,
          borderColor: colors.border,
        }}
      >
        {selected ? <Icon name="check" size={14} color={colors.primaryForeground} /> : null}
      </View>
    </PressableScale>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/__tests__/SelectableCard.test.tsx`
Expected: PASS, 5 tests.

If the `minHeight` assertion fails because `PressableScale` merges styles into an array,
adjust the test's flattening rather than weakening the assertion.

- [ ] **Step 5: Mutation-check**

Temporarily hardcode `selected={false}` semantics by replacing `accessibilityState={{ selected }}`
with `accessibilityState={{ selected: false }}` — the first test must FAIL. Restore.
Temporarily render the icon tile unconditionally — the icon-tile test must FAIL. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: clean.

```bash
git add src/components/SelectableCard.tsx src/components/__tests__/SelectableCard.test.tsx
git commit -m "feat(mobile): add the selectable card from the onboarding mockup"
```

---

### Task 4: `AuthScaffold` component

The sticky-footer layout the mockup uses and every pre-app screen currently lacks.

**Files:**
- Create: `src/components/AuthScaffold.tsx`
- Test: `src/components/__tests__/AuthScaffold.test.tsx`

**Interfaces:**
- Consumes: `AppBackground`, `useSafeAreaInsets`, `Icon`, `PressableScale`.
- Produces:

```ts
type AuthScaffoldProps = {
  children: React.ReactNode;
  footer: React.ReactNode;
  onBack?: () => void;
  progress?: { step: number; total: number };
};
export function AuthScaffold(props: AuthScaffoldProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/AuthScaffold.test.tsx`:

```tsx
import { Text } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import { AuthScaffold } from "../AuthScaffold";

test("renders body and footer content", () => {
  const { getByText } = render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getByText("Body")).toBeTruthy();
  expect(getByText("Continue")).toBeTruthy();
});

test("the footer is separated by a top border so it reads as sticky", () => {
  const { getByTestId } = render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  const footer = getByTestId("auth-scaffold-footer");
  expect(footer.props.style.borderTopWidth).toBe(1);
  expect(footer.props.style.borderTopColor).toBeTruthy();
});

test("no back control is rendered unless onBack is supplied", () => {
  const { queryByLabelText } = render(
    <AuthScaffold footer={<Text>Continue</Text>}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(queryByLabelText("Go back")).toBeNull();
});

test("onBack renders a labelled control and fires it", () => {
  const onBack = jest.fn();
  const { getByLabelText } = render(
    <AuthScaffold footer={<Text>Continue</Text>} onBack={onBack}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  fireEvent.press(getByLabelText("Go back"));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("progress renders one dot per step and marks the current one", () => {
  const { getAllByTestId, getByLabelText } = render(
    <AuthScaffold footer={<Text>Continue</Text>} progress={{ step: 2, total: 2 }}>
      <Text>Body</Text>
    </AuthScaffold>,
  );
  expect(getAllByTestId("progress-dot")).toHaveLength(2);
  expect(getByLabelText("Step 2 of 2")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/__tests__/AuthScaffold.test.tsx`
Expected: FAIL — "Cannot find module '../AuthScaffold'".

- [ ] **Step 3: Write the implementation**

Create `src/components/AuthScaffold.tsx`:

```tsx
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackground } from "./AppBackground";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  children: ReactNode;
  footer: ReactNode;
  onBack?: () => void;
  progress?: { step: number; total: number };
};

// Shared layout for the pre-app screens. The primary action lives in a sticky
// footer outside the scroll view (as in the mockup) so it is reachable without
// scrolling to the bottom of a long form — the shipped screens put it inline at
// the end of the scroll, where a user with the keyboard open could not see it.
export function AuthScaffold({ children, footer, onBack, progress }: Props) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />

      {onBack || progress ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.md,
            paddingTop: insets.top + spacing.sm,
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.sm,
          }}
        >
          {onBack ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Go back"
              haptic="selection"
              hitSlop={12}
              onPress={onBack}
              style={{ minWidth: 44, minHeight: 44, justifyContent: "center" }}
            >
              <Icon name="arrow-left" size={22} color={colors.label} />
            </PressableScale>
          ) : null}

          {progress ? (
            <View
              accessibilityLabel={`Step ${progress.step} of ${progress.total}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              {Array.from({ length: progress.total }, (_, i) => (
                <View
                  key={i}
                  testID="progress-dot"
                  style={{
                    width: i + 1 === progress.step ? 20 : 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: i + 1 === progress.step ? colors.primary : colors.border,
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: onBack || progress ? spacing.sm : insets.top + spacing.lg,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.lg,
          gap: spacing.md,
        }}
      >
        {children}
      </ScrollView>

      <View
        testID="auth-scaffold-footer"
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: insets.bottom + spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        {footer}
      </View>
    </View>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/__tests__/AuthScaffold.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-check**

Temporarily drop `borderTopWidth: 1` — the border test must FAIL. Restore. Temporarily
render the back control unconditionally — the "no back control" test must FAIL. Restore.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: clean.

```bash
git add src/components/AuthScaffold.tsx src/components/__tests__/AuthScaffold.test.tsx
git commit -m "feat(mobile): add the pre-app scaffold with a sticky footer action"
```

---

### Task 5: Split onboarding into two steps

The largest task. Every existing onboarding test breaks here, because "Get started" moves
to step 2 — that is expected and each must be updated to press "Continue" first.

**Files:**
- Modify: `app/onboarding.tsx` (full rewrite of the render; `onSubmit` logic unchanged)
- Modify: `app/__tests__/onboarding.test.tsx`

**Interfaces:**
- Consumes: `BrandLockup` (Task 2), `SelectableCard` (Task 3), `AuthScaffold` (Task 4),
  `Button` with `iconPosition="trailing"` (Task 1).
- Produces: no exported API change — `export default function Onboarding()`.

- [ ] **Step 1: Update the tests to the two-step flow**

Rewrite `app/__tests__/onboarding.test.tsx`. Keep the existing mocks block at the top
verbatim (`expo-router`, `@/api/hooks`, `@/motion`, `@/units`, and the `beforeEach`), and
replace the tests with:

```tsx
// Step 1 shows the goal picker; the details live on step 2.
async function advanceToStep2(ui: ReturnType<typeof render>) {
  await fireEvent.press(ui.getByText("Continue"));
}

test("step 1 shows the brand, the hero and the goal cards", async () => {
  const { findByText, getByTestId } = await render(<Onboarding />);
  expect(getByTestId("sf-sparkles")).toBeTruthy();
  expect(await findByText(/Otto tracks it/i)).toBeTruthy();
  expect(await findByText("Lose weight")).toBeTruthy();
  expect(await findByText("Build muscle")).toBeTruthy();
  expect(await findByText("Continue")).toBeTruthy();
});

test("step 1 does not yet show the details fields or the final action", async () => {
  const { queryByText, queryByLabelText } = await render(<Onboarding />);
  expect(queryByLabelText("Birth year")).toBeNull();
  expect(queryByText("Get started")).toBeNull();
});

it("shows a non-medical disclaimer on the details step", async () => {
  const ui = await render(<Onboarding />);
  await advanceToStep2(ui);
  expect(screen.getByText(/not medical advice/i)).toBeTruthy();
});

test("selecting a goal marks exactly one card selected", async () => {
  const { getByText, getAllByRole } = await render(<Onboarding />);
  const selectedCount = () =>
    getAllByRole("radio").filter((n) => n.props.accessibilityState?.selected).length;
  // "Lose weight" (fat_loss) is selected by default.
  expect(selectedCount()).toBe(1);
  await fireEvent.press(getByText("Build muscle"));
  expect(selectedCount()).toBe(1);
});

test("activity levels are selectable cards, so no label is truncated", async () => {
  const ui = await render(<Onboarding />);
  await advanceToStep2(ui);
  // The five levels render in full. Under the old equal-split Segmented,
  // "Sedentary" wrapped to "Sedentar/y".
  expect(ui.getByText("Sedentary")).toBeTruthy();
  expect(ui.getByText("Very active")).toBeTruthy();
});

test("submit is blocked with an error when the numeric fields fail validation", async () => {
  const ui = await render(<Onboarding />);
  await advanceToStep2(ui);
  await fireEvent.press(ui.getByText("Get started"));
  expect(mockMutate).not.toHaveBeenCalled();
  expect(await ui.findByText("Please fill in your birth year, height, and weight.")).toBeTruthy();
});

test("the goal chosen on step 1 survives the step transition and reaches the payload", async () => {
  const ui = await render(<Onboarding />);
  await fireEvent.press(ui.getByText("Build muscle"));
  await advanceToStep2(ui);
  await fireEvent.press(ui.getByText("Female"));
  await fireEvent.press(ui.getByText("Active"));
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in centimetres"), "170");
  await fireEvent.changeText(ui.getByLabelText("Weight in kilograms"), "65");
  await fireEvent.press(ui.getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledTimes(1);
  expect(mockMutate).toHaveBeenCalledWith(
    {
      sex: "female",
      goal: "muscle_gain",
      activity_level: "active",
      birth_year: 1995,
      height_cm: 170,
      weight_kg: 65,
    },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );

  const { onSuccess } = mockMutate.mock.calls[0][1];
  onSuccess();
  expect(haptics.success).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledWith("/");
});

test("going back to step 1 preserves what was already entered on step 2", async () => {
  const ui = await render(<Onboarding />);
  await advanceToStep2(ui);
  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1988");
  await fireEvent.press(ui.getByLabelText("Go back"));
  expect(ui.getByText("Lose weight")).toBeTruthy();
  await advanceToStep2(ui);
  expect(ui.getByLabelText("Birth year").props.value).toBe("1988");
});

test("imperial: submit converts ft/in + lb inputs to metric height_cm/weight_kg", async () => {
  mockUseUnits.mockReturnValue({ system: "imperial", setSystem: jest.fn() });
  const ui = await render(<Onboarding />);
  await advanceToStep2(ui);

  await fireEvent.changeText(ui.getByLabelText("Birth year"), "1995");
  await fireEvent.changeText(ui.getByLabelText("Height in feet"), "5");
  await fireEvent.changeText(ui.getByLabelText("Height in inches"), "11");
  await fireEvent.changeText(ui.getByLabelText("Weight in pounds"), "150");
  await fireEvent.press(ui.getByText("Get started"));

  expect(mockMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      birth_year: 1995,
      height_cm: expect.closeTo(180.34, 2), // 5'11" -> cm
      weight_kg: expect.closeTo(68.0388555, 4), // 150 lb -> kg
    }),
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- app/__tests__/onboarding.test.tsx`
Expected: FAIL — no "Continue" text exists yet; `sf-sparkles`, `Go back` and the
`radio` roles are all absent.

- [ ] **Step 3: Rewrite the onboarding render**

In `app/onboarding.tsx`, replace the imports block with:

```tsx
import { useEffect, useState } from "react";
import { BackHandler, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { BrandLockup } from "@/components/BrandLockup";
import { SelectableCard } from "@/components/SelectableCard";
import { AuthScaffold } from "@/components/AuthScaffold";
import { useSubmitOnboarding } from "@/api/hooks";
import type { OnboardingInput } from "@/api/types";
import { useTheme } from "@/theme";
import { validateOnboardingNumbers } from "@/lib/validateOnboarding";
import { haptics } from "@/motion";
import { cmFromFtIn, kgFromLb, useUnits } from "@/units";
```

Replace the `ACTIVITY_OPTIONS` constant with descriptor-carrying entries:

```tsx
const ACTIVITY_OPTIONS: Array<{ key: OnboardingInput["activity_level"]; label: string; sub: string }> = [
  { key: "sedentary", label: "Sedentary", sub: "Desk job, little walking" },
  { key: "light", label: "Light", sub: "1–2 sessions a week" },
  { key: "moderate", label: "Moderate", sub: "3–5 sessions a week" },
  { key: "active", label: "Active", sub: "6–7 sessions a week" },
  { key: "very_active", label: "Very active", sub: "Physical job or athlete" },
];
```

Add `step` state alongside the existing state hooks:

```tsx
  const [step, setStep] = useState<1 | 2>(1);
```

Add the Android hardware-back subscription immediately after the state hooks. Without it,
hardware back on step 2 leaves onboarding entirely, losing everything the user entered:

```tsx
  useEffect(() => {
    if (step !== 2) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setStep(1);
      return true; // handled — do not pop the route
    });
    return () => sub.remove();
  }, [step]);
```

Leave `onSubmit` **entirely unchanged**. Replace the whole `return (...)` block with:

```tsx
  if (step === 1) {
    return (
      <AuthScaffold
        progress={{ step: 1, total: 2 }}
        footer={
          <Button
            title="Continue"
            icon="arrow-right"
            iconPosition="trailing"
            onPress={() => setStep(2)}
          />
        }
      >
        <BrandLockup />
        <AppText variant="title1" style={{ marginTop: spacing.md }}>
          Snap it.{"\n"}Otto tracks it.
        </AppText>
        <AppText muted>
          Photo or chat — log meals in seconds and let AI handle the calories and macros.
        </AppText>

        <Overline style={{ marginTop: spacing.sm }}>What&apos;s your goal?</Overline>
        <View accessibilityRole="radiogroup" style={{ gap: spacing.sm }}>
          {GOALS.map((g) => (
            <SelectableCard
              key={g.id}
              icon={g.icon}
              title={g.title}
              subtitle={g.sub}
              selected={goal === g.id}
              onPress={() => setGoal(g.id)}
            />
          ))}
        </View>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      onBack={() => setStep(1)}
      progress={{ step: 2, total: 2 }}
      footer={
        <Button
          title={submit.isPending ? "Saving…" : "Get started"}
          icon="arrow-right"
          iconPosition="trailing"
          onPress={onSubmit}
          disabled={submit.isPending}
        />
      }
    >
      <AppText variant="title1">About you</AppText>

      <Segmented
        options={SEX_OPTIONS}
        value={sex}
        onChange={(key) => setSex(key as OnboardingInput["sex"])}
      />

      <View style={{ gap: spacing.sm }}>
        <Card variant="elevated" style={{ padding: 0 }}>
          <TextInput
            accessibilityLabel="Birth year"
            style={filledInputStyle}
            placeholder="Birth year (e.g. 1995)"
            placeholderTextColor={colors.secondaryLabel}
            keyboardType="number-pad"
            value={birthYear}
            onChangeText={setBirthYear}
          />
        </Card>
        {system === "imperial" ? (
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Card variant="elevated" style={{ padding: 0, flex: 1 }}>
              <TextInput
                accessibilityLabel="Height in feet"
                style={filledInputStyle}
                placeholder="Height (ft)"
                placeholderTextColor={colors.secondaryLabel}
                keyboardType="number-pad"
                value={heightFt}
                onChangeText={setHeightFt}
              />
            </Card>
            <Card variant="elevated" style={{ padding: 0, flex: 1 }}>
              <TextInput
                accessibilityLabel="Height in inches"
                style={filledInputStyle}
                placeholder="Height (in)"
                placeholderTextColor={colors.secondaryLabel}
                keyboardType="number-pad"
                value={heightIn}
                onChangeText={setHeightIn}
              />
            </Card>
          </View>
        ) : (
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Height in centimetres"
              style={filledInputStyle}
              placeholder="Height (cm)"
              placeholderTextColor={colors.secondaryLabel}
              keyboardType="decimal-pad"
              value={heightCm}
              onChangeText={setHeightCm}
            />
          </Card>
        )}
        <Card variant="elevated" style={{ padding: 0 }}>
          <TextInput
            accessibilityLabel={system === "imperial" ? "Weight in pounds" : "Weight in kilograms"}
            style={filledInputStyle}
            placeholder={system === "imperial" ? "Weight (lb)" : "Weight (kg)"}
            placeholderTextColor={colors.secondaryLabel}
            keyboardType="decimal-pad"
            value={weightText}
            onChangeText={setWeightText}
          />
        </Card>
      </View>

      <Overline style={{ marginTop: spacing.sm }}>Activity</Overline>
      <View accessibilityRole="radiogroup" style={{ gap: spacing.sm }}>
        {ACTIVITY_OPTIONS.map((a) => (
          <SelectableCard
            key={a.key}
            title={a.label}
            subtitle={a.sub}
            selected={activity === a.key}
            onPress={() => setActivity(a.key)}
          />
        ))}
      </View>

      {error ? (
        <AppText
          variant="footnote"
          accessibilityLiveRegion="polite"
          style={{ color: colors.destructive }}
        >
          {error}
        </AppText>
      ) : null}
      <AppText variant="footnote" muted style={{ textAlign: "center" }}>
        Kora gives general nutrition information, not medical advice. For medical concerns,
        talk to a healthcare professional.
      </AppText>
    </AuthScaffold>
  );
```

Remove the now-unused `ScrollView`, `useSafeAreaInsets`, `Icon`, `GroupedSection`, `Row`
and `AppBackground` imports, and the `insets` variable.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- app/__tests__/onboarding.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-check the step boundary**

The load-bearing property is that step 1's goal survives into the payload. Temporarily
change step 2's footer to submit a hardcoded `goal: "fat_loss"` — the "goal chosen on
step 1 survives" test must FAIL with `muscle_gain` vs `fat_loss`. Restore.

Then temporarily make the back control call `router.back()` instead of `setStep(1)` — the
"going back preserves" test must FAIL. Restore.

- [ ] **Step 6: Full verification and commit**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npm test` — expected: all suites pass.

```bash
git add app/onboarding.tsx app/__tests__/onboarding.test.tsx
git commit -m "feat(mobile): split onboarding into a goal step and a details step"
```

---

### Task 6: `firebaseAuthMessage` helper

Pure function, no React. Built and tested separately so Task 7 only has to wire it.

**Files:**
- Create: `src/lib/firebaseAuthMessage.ts`
- Test: `src/lib/__tests__/firebaseAuthMessage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function firebaseAuthMessage(error: unknown): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/firebaseAuthMessage.test.ts`:

```ts
import { firebaseAuthMessage } from "../firebaseAuthMessage";

test.each([
  ["auth/email-already-in-use", "That email already has an account. Try signing in."],
  ["auth/weak-password", "Choose a password of at least 6 characters."],
  ["auth/invalid-email", "That doesn't look like a valid email address."],
  ["auth/network-request-failed", "Couldn't reach Kora. Check your connection."],
  ["auth/too-many-requests", "Too many attempts. Wait a moment and try again."],
])("maps %s to its specific message", (code, expected) => {
  expect(firebaseAuthMessage({ code })).toBe(expected);
});

test.each(["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"])(
  "%s is deliberately vague so it cannot be used to enumerate accounts",
  (code) => {
    expect(firebaseAuthMessage({ code })).toBe("Email or password is incorrect.");
  },
);

test("an unknown code falls back to a generic message", () => {
  expect(firebaseAuthMessage({ code: "auth/some-future-code" })).toBe(
    "Something went wrong. Please try again.",
  );
});

test("a non-Firebase value does not throw and still yields the fallback", () => {
  expect(firebaseAuthMessage(undefined)).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
  expect(firebaseAuthMessage({})).toBe("Something went wrong. Please try again.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/__tests__/firebaseAuthMessage.test.ts`
Expected: FAIL — "Cannot find module '../firebaseAuthMessage'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/firebaseAuthMessage.ts`:

```ts
// Firebase auth errors carry a `code`. The shipped screen collapsed every failure
// to "Sign-in failed. Check your email and password.", which is actively wrong for
// a weak password or a network outage, and discards the only actionable detail.
//
// invalid-credential / wrong-password / user-not-found deliberately share one
// vague message: distinguishing "no such account" from "wrong password" would let
// an attacker enumerate which email addresses are registered.
const MESSAGES: Record<string, string> = {
  "auth/email-already-in-use": "That email already has an account. Try signing in.",
  "auth/weak-password": "Choose a password of at least 6 characters.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/network-request-failed": "Couldn't reach Kora. Check your connection.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
};

const FALLBACK = "Something went wrong. Please try again.";

export function firebaseAuthMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return FALLBACK;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return FALLBACK;
  return MESSAGES[code] ?? FALLBACK;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/__tests__/firebaseAuthMessage.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: clean.

```bash
git add src/lib/firebaseAuthMessage.ts src/lib/__tests__/firebaseAuthMessage.test.ts
git commit -m "feat(mobile): map Firebase auth error codes to specific messages"
```

---

### Task 7: Rework the sign-in screen

**Files:**
- Modify: `app/sign-in.tsx`
- Test: `app/__tests__/sign-in.test.tsx` (create if absent; check first with
  `ls app/__tests__/`)

**Interfaces:**
- Consumes: `BrandLockup`, `AuthScaffold`, `Button` + `iconPosition`, `firebaseAuthMessage`.
- Produces: no exported API change — `export default function SignIn()`.

- [ ] **Step 1: Write the failing test**

Create `app/__tests__/sign-in.test.tsx`:

```tsx
import { fireEvent, render, waitFor } from "@testing-library/react-native";

const mockSignIn = jest.fn();
const mockCreate = jest.fn();
let mockParams: { reason?: string } = {};

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...a: unknown[]) => mockSignIn(...a),
  createUserWithEmailAndPassword: (...a: unknown[]) => mockCreate(...a),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

import SignIn from "../sign-in";

beforeEach(() => {
  mockSignIn.mockReset().mockResolvedValue({});
  mockCreate.mockReset().mockResolvedValue({});
  mockParams = {};
});

test("defaults to sign-in mode and calls signInWithEmailAndPassword", async () => {
  const { getByText, getByLabelText } = render(<SignIn />);
  fireEvent.changeText(getByLabelText("Email"), "a@b.co");
  fireEvent.changeText(getByLabelText("Password"), "secret123");
  fireEvent.press(getByText("Sign in"));
  await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
  expect(mockCreate).not.toHaveBeenCalled();
});

test("switching to create-account mode calls createUserWithEmailAndPassword", async () => {
  const { getByText, getByLabelText } = render(<SignIn />);
  fireEvent.press(getByText("Create account"));
  fireEvent.changeText(getByLabelText("Email"), "a@b.co");
  fireEvent.changeText(getByLabelText("Password"), "secret123");
  fireEvent.press(getByText("Create account", { exact: true }));
  await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
  expect(mockSignIn).not.toHaveBeenCalled();
});

test("a weak-password failure reports the real reason, not a password-check message", async () => {
  mockCreate.mockRejectedValue({ code: "auth/weak-password" });
  const { getByText, findByText } = render(<SignIn />);
  fireEvent.press(getByText("Create account"));
  fireEvent.press(getByText("Create account", { exact: true }));
  expect(await findByText("Choose a password of at least 6 characters.")).toBeTruthy();
});

test("an already-registered email is reported as such", async () => {
  mockCreate.mockRejectedValue({ code: "auth/email-already-in-use" });
  const { getByText, findByText } = render(<SignIn />);
  fireEvent.press(getByText("Create account"));
  fireEvent.press(getByText("Create account", { exact: true }));
  expect(await findByText("That email already has an account. Try signing in.")).toBeTruthy();
});

test("the forced-sign-out expiry notice still renders", () => {
  mockParams = { reason: "expired" };
  const { getByText } = render(<SignIn />);
  expect(getByText("Your session expired. Please sign in again.")).toBeTruthy();
});

test("the brand lockup is present", () => {
  const { getByTestId } = render(<SignIn />);
  expect(getByTestId("sf-sparkles")).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- app/__tests__/sign-in.test.tsx`
Expected: FAIL — there is no mode toggle, so `getByText("Create account", { exact: true })`
is ambiguous/absent, and `sf-sparkles` does not render.

- [ ] **Step 3: Rewrite the sign-in screen**

Replace the whole body of `app/sign-in.tsx` with:

```tsx
import { useState } from "react";
import { KeyboardAvoidingView, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Segmented } from "@/components/Segmented";
import { BrandLockup } from "@/components/BrandLockup";
import { AuthScaffold } from "@/components/AuthScaffold";
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import { useTheme } from "@/theme";

type Mode = "in" | "up";

const MODE_OPTIONS: Array<{ key: Mode; label: string }> = [
  { key: "in", label: "Sign in" },
  { key: "up", label: "Create account" },
];

export default function SignIn() {
  if (!isFirebaseConfigured) return null;

  const { colors, spacing, fontSize } = useTheme();
  // Set by api.ts's forced sign-out (a 401 that survived a token refresh) via the
  // redirect (tabs)/_layout.tsx makes when the session becomes unusable — not
  // present on a manual sign-out. Verified on a device against live prod.
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() =>
    reason === "expired" ? "Your session expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

  const filledInputStyle = {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
    minHeight: 48,
  } as const;

  async function submit() {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch (e: unknown) {
      setError(firebaseAuthMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const cta = mode === "in" ? "Sign in" : "Create account";

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <AuthScaffold
        footer={
          <Button
            title={busy ? "…" : cta}
            icon="arrow-right"
            iconPosition="trailing"
            onPress={submit}
            disabled={busy}
          />
        }
      >
        <BrandLockup />
        <AppText variant="title1" style={{ marginTop: spacing.md }}>
          {mode === "in" ? "Welcome back." : "Start with Kora."}
        </AppText>
        <AppText muted>
          {mode === "in"
            ? "Sign in to pick up where you left off."
            : "Create an account and log your first meal in seconds."}
        </AppText>

        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={(key) => {
            setMode(key as Mode);
            setError(null);
          }}
        />

        <View style={{ gap: spacing.sm }}>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Email"
              style={filledInputStyle}
              placeholder="Email"
              placeholderTextColor={colors.secondaryLabel}
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </Card>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Password"
              style={filledInputStyle}
              placeholder="Password"
              placeholderTextColor={colors.secondaryLabel}
              secureTextEntry
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              textContentType={mode === "in" ? "password" : "newPassword"}
              value={password}
              onChangeText={setPassword}
            />
          </Card>
        </View>

        {error ? (
          <AppText
            variant="footnote"
            accessibilityLiveRegion="polite"
            style={{ color: colors.destructive }}
          >
            {error}
          </AppText>
        ) : null}
      </AuthScaffold>
    </KeyboardAvoidingView>
  );
}
```

Note the mode `Segmented` and the footer CTA both render the string "Create account" in
sign-up mode. The tests disambiguate with `{ exact: true }` plus press order; if RNTL still
reports ambiguity, give the footer `Button` a `testID="auth-submit"` and query that
instead — do **not** reword the button to dodge the collision.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- app/__tests__/sign-in.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check**

Temporarily restore the old catch-all (`setError("Sign-in failed. Check your email and
password.")`) — the weak-password and email-already-in-use tests must FAIL. Restore.
Temporarily hardcode `mode` to `"in"` — the create-account test must FAIL. Restore.

- [ ] **Step 6: Full verification and commit**

Run: `npx tsc --noEmit` — expected: clean.
Run: `npm test` — expected: all suites pass.

```bash
git add app/sign-in.tsx app/__tests__/sign-in.test.tsx
git commit -m "feat(mobile): give sign-in an explicit mode and real error messages"
```

---

---

## Tasks 8–10 — activity inference from Health data (added 2026-08-01)

Added after the user observed that the goal and activity questions read as
MyFitnessPal boilerplate. See the spec's §3a amendment for the design and rationale.
All three are implemented; recorded here for the branch history.

**Task 8 — `src/health/inferActivity.ts`** (commit `4c54148`). Pure function, no
HealthKit: step bands → base level, workout load lifts it (+1 at ≥3/wk, +2 at ≥5),
capped. Returns `null` for insufficient evidence. 19 tests. Mutations caught:
all-zero steps flooring to `sedentary`; accepting short windows; dropping the workout
bump; removing the cap.

**Task 9 — `src/health/useActivityHistory.ts`** (commit `8b6d090`). Opt-in hook:
14-day step window + workouts, lazily requiring the Nitro module so a missing native
side degrades instead of redboxing. Exports `bucketStepsByDay` / `workoutsPerWeek` so
the bucketing is testable without HealthKit. 15 tests. Mutations caught: zero-filling
absent days; treating thin data as `sedentary`; requesting authorization eagerly.
Also adds `queryWorkoutSamples` to the global mock in `jest.setup.js`.

**Task 10 — `src/components/ActivityFromHealth.tsx` + wiring** (commit `0698921`).
Opt-in affordance above the card list; on success states the evidence *and* the
conclusion and requires confirmation. 9 component tests + 2 integration tests in
`onboarding.test.tsx`. Mutations caught: collapsing the three unusable states into
one vague message; auto-applying without confirmation; `onAccept` not setting state.

**Device-verified:** the real HealthKit sheet appears only on tap, requests the
Workouts scope, and a device with no step history shows "There isn't enough recent
activity yet to tell" with the card list intact — no level invented. Note HealthKit
read permissions cannot distinguish *denied* from *authorized-but-empty*, so a
decline surfaces as `insufficient`; both are handled and neither guesses.

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm test` — every suite passes. Record the suite/test counts.
- [ ] `npx expo lint` — no new warnings.
- [ ] **Device pass.** Automated tests cannot see any of this — RNTL renders without layout,
  so truncation, overlap and unreachable controls are all invisible to it. This is the same
  class of defect that produced an Undo button rendering underneath its own sheet. On a
  simulator with Metro on port 8082:
  - Step 1: brand mark renders as a sparkles tile (**not** a grey circle — that is the
    `Icon` fallback and means Task 1 regressed), goal cards show border + tile fill + radio
    when selected, "Continue →" sits in a footer that does not scroll away.
  - Step 2: all five activity labels render on one line each — "Sedentary" must not read
    "Sedentar/y". Back chevron returns to step 1 with entries preserved. Android hardware
    back does the same.
  - Sign-in: mode toggle switches heading and CTA; submitting a 5-character password in
    create-account mode shows "Choose a password of at least 6 characters."
  - Both themes: run once in light and once in dark (`Settings > Developer > Appearance`),
    since every colour here is theme-derived.
