# Kora pre-app flow — onboarding and auth polish

**Date:** 2026-08-01
**Scope:** `apps/mobile` — `app/sign-in.tsx`, `app/onboarding.tsx`, three new shared
components, and one new lib helper (`firebaseAuthMessage`)
**Branch:** `kora-onboarding-polish` off `main` (its own PR; deliberately not stacked on #64)

## Why

The pre-app flow is the only thing a beta user sees before they can do anything, and it
had never been run end to end until the gateway JWT fix landed today — until then no Kora
user could authenticate at all, so nobody had ever looked at these screens against a live
API.

The onboarding screen has also drifted a long way from its mockup,
`design-system/ui_kits/kora/Onboarding.jsx`, which is the design authority for this
surface. Observed divergences, plus two defects visible on a simulator:

| Mockup | Shipped |
|---|---|
| Brand lockup: `primary` tile + `sparkles` + "Kora" wordmark | absent |
| Goal cards: 2px `primary` border + shadow when selected, 42px icon tile that fills, 22px radio | flat `GroupedSection` list with a bare check icon |
| Sticky footer CTA with `borderTop`, outside the scroll | button inline at the end of the scroll |
| "Get started" + `arrow-right` | no icon (though `Button` already accepts one) |
| Goal picker is the whole screen | goal + sex + birth year + height + weight + activity in one scroll |

**Defect 1.** `Segmented` divides width equally across its options. With five activity
levels, "Sedentary" renders as `Sedentar/y` and "Very active" wraps to two lines.

**Defect 2.** `sign-in.tsx` maps *every* failure to
`"Sign-in failed. Check your email and password."` — so a user whose password is too short
is told to check their password, and the real reason is discarded. The same screen greets
a brand-new user with "Welcome back".

## Non-goals

- No change to the onboarding API contract. `OnboardingInput` and the single
  `submit.mutate` call are unchanged.
- No change to `validateOnboardingNumbers` or the unit-conversion logic.
- Not fixing the dev-menu gear that overlaps the weight field on a simulator — that is the
  Expo dev-client menu, not application UI, and does not exist in a release build.
- No other pre-app surfaces (`config-missing`, splash) in this pass.

## Design

### 1. Shared primitives

Three new components in `apps/mobile/src/components/`. Reuse across all four screens is the
point: it is what makes the flow read as one product rather than four screens that happen
to be adjacent.

**`BrandLockup`** — 40×40 tile, `radii.lg`, filled `colors.primary`, `sparkles` icon at 22
in `colors.primaryForeground`, beside a "Kora" wordmark at 20/800/`-0.02em`. Taken from the
mockup verbatim. Renders on sign-in and onboarding step 1.

**`AuthScaffold`** — layout wrapper providing `AppBackground`, safe-area padding, a
scrollable body, and a **sticky footer** (`borderTop: colors.border`) holding the primary
CTA. Props: `children`, `footer`, optional `onBack`. The sticky footer is the mockup's
structure and is currently missing from every screen in the flow.

**`SelectableCard`** — the mockup's goal card, generalised so it serves both the goal
picker and the activity list:

| State | Card | Icon tile | Radio |
|---|---|---|---|
| selected | 2px `colors.primary` border, `shadows.md` | `colors.primary` fill, icon `primaryForeground` | filled `primary` + `check` |
| unselected | 2px `colors.border`, no shadow | `colors.cardSecondary`, icon `primary` | 2px `border` ring |

Props: `icon?`, `title`, `subtitle`, `selected`, `onPress`.

`icon` is optional, and the two uses differ deliberately: **the goal picker passes an icon,
the activity list does not.** Three goals are a headline choice and earn the tiles; five
activity rows with tiles would be a wall of green squares, and the levels are already
distinguished by their descriptors. Cards without an icon lay their title and subtitle out
from the leading edge, keeping the radio column aligned with the goal cards above.

### 2. Onboarding — two steps, one route

`app/onboarding.tsx` keeps a **single Expo Router route** and holds `step: 1 | 2` in state.
Rationale: step-1 state needs no cross-route plumbing, and there remains exactly one
`submit.mutate` call at the end, so the API contract and error handling stay as they are.

Both steps show the same 2-dot progress indicator, so the user knows on first sight that
this is two screens and not an endless form. Step 1 has no back chevron (there is nothing
behind it); step 2 does.

**Step 1** — `BrandLockup`; `Snap it.\nOtto tracks it.` as `title1`; the existing subtitle
paragraph; `WHAT'S YOUR GOAL?` overline; three `SelectableCard`s; sticky footer
`Continue` + `arrow-right`. No validation — `goal` always has a default, so Continue is
never blocked.

**Step 2** — back chevron and the 2-dot progress indicator; "About you"; sex `Segmented`
(two options, so no wrap risk); birth year / height / weight fields exactly as today
including the imperial branch; `ACTIVITY` overline with five `SelectableCard`s; the medical
disclaimer; sticky footer `Get started` + `arrow-right`.

Activity descriptors, which also remove the jargon problem:

| Level | Descriptor |
|---|---|
| `sedentary` | Desk job, little walking |
| `light` | 1–2 sessions a week |
| `moderate` | 3–5 sessions a week |
| `active` | 6–7 sessions a week |
| `very_active` | Physical job or athlete |

Back behaviour: the header chevron returns to step 1. On Android, the hardware back button
must do the same rather than leaving onboarding — a `BackHandler` subscription active only
while `step === 2`. Returning to step 1 preserves every field already entered.

Validation stays on step 2 and behaves as today: errors render inline and do not advance.

### 3. Sign-in / create account

**Mode becomes explicit.** A `Segmented` with "Sign in" / "Create account" at the top drives
a single footer CTA, replacing the two equally-weighted buttons. The "Welcome back"
overline is shown only in sign-in mode; create-account mode gets its own heading.

**Error mapping.** Replace the single catch-all string with a `firebaseAuthMessage(code)`
helper in `src/lib/`:

| Code | Message |
|---|---|
| `auth/email-already-in-use` | That email already has an account. Try signing in. |
| `auth/weak-password` | Choose a password of at least 6 characters. |
| `auth/invalid-email` | That doesn't look like a valid email address. |
| `auth/invalid-credential`, `auth/wrong-password`, `auth/user-not-found` | Email or password is incorrect. |
| `auth/network-request-failed` | Couldn't reach Kora. Check your connection. |
| `auth/too-many-requests` | Too many attempts. Wait a moment and try again. |
| anything else | Something went wrong. Please try again. |

The deliberately vague fallback for `invalid-credential`/`wrong-password`/`user-not-found`
is an account-enumeration guard: distinguishing "no such user" from "wrong password" tells
an attacker which emails are registered.

**Unchanged:** the `reason === "expired"` notice. It was verified on a device against live
prod and is the visible half of the forced-sign-out recovery path — it must keep rendering
`"Your session expired. Please sign in again."`

**Also:** `textContentType` / `autoComplete` set per mode (`password` vs `new-password`) so
the iOS password manager offers the right action.

### 4. Accessibility

- 44pt minimum hit target on every `SelectableCard` (42px tile + padding clears this).
- `accessibilityRole="radio"` with `accessibilityState={{ selected }}` on each card;
  `accessibilityRole="radiogroup"` on the containing view of each group.
- Error text carries `accessibilityLiveRegion="polite"`.
- The selection spring respects `prefers-reduced-motion` via the existing `@/motion` helpers.

## Testing

`app/__tests__/onboarding.test.tsx` needs reworking for the step split — it currently
assumes one screen.

Onboarding:
- Step 1 → Continue → step 2 → Get started submits **once**, carrying the goal chosen on
  step 1 (guards against the goal being dropped across the step boundary).
- Back from step 2 returns to step 1 and preserves the entered values.
- A validation error on step 2 renders and does **not** submit.
- Each activity card maps to the correct `activity_level` value.

Sign-in:
- Switching mode changes which Firebase function is called.
- Each mapped error code renders its specific message; an unmapped code renders the fallback.
- `reason=expired` still renders the expiry notice.

Every new test must be mutation-checked: break the behaviour it claims to cover and
confirm it fails. Assertions that pass against a control that never renders — the vacuous
`for range` pattern this repo has hit repeatedly — do not count as coverage.

## Risks

- `Segmented`'s indicator is `width: 100/n %` with `translateX: index*100%`; correct for the
  two-option uses that remain. The five-option use is being removed, which is the fix.
- Reworking `onboarding.test.tsx` is the largest single piece of work here and the place a
  regression is most likely to slip through unnoticed.
- `sign-in.tsx` returns `null` before calling hooks when Firebase is unconfigured. This is
  stable only because `isFirebaseConfigured` is a module constant. Left as-is; noted so the
  next person doesn't make it conditional.
