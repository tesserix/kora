# Account Deletion — Mobile Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Kora user a discoverable, irreversible in-app path to delete their account, satisfying App Store Review Guideline 5.1.1(v) and unblocking #109.

**Architecture:** Three thin layers, each independently testable. A plain `deleteAccount()` function in the API layer wraps `DELETE /v1/me` (the server endpoint, ownership transfer and Apple revocation are already built and green). A dedicated `app/delete-account.tsx` confirmation screen gates the call behind typing the word `delete`. A destructive row in `app/settings.tsx` routes to it. No new state management, no new dependencies.

**Tech Stack:** Expo SDK 57 / expo-router (file-based routing), React Native, TypeScript, Firebase Auth (`signOut`), Jest + `@testing-library/react-native`.

## Global Constraints

- **Expo v57.** Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing code. Expo has changed; do not rely on remembered APIs.
- **Both suites must stay green:** `cd apps/mobile && npx tsc --noEmit` and `cd apps/mobile && npx jest --ci --forceExit`.
- **No `console.log`** anywhere in `app/` or `src/`. The repo convention for a deliberately swallowed best-effort failure is a commented empty `catch` — see `src/lib/push.ts:46-50` and `src/motion/haptics.ts`.
- **Never surface a raw `error.message`.** All API failure copy goes through `apiErrorMessage` from `@/lib/apiErrorMessage`. This is a standing rule from #108.
- **Immutability.** Never mutate existing objects; construct new ones.
- **Explicit types on exported functions.** Props get a named `type` or `interface`. No `any`.
- **Commit messages are single-line**, conventional-commit prefixed, with no signature and no body.
- **Spec of record:** `docs/superpowers/specs/2026-08-07-account-deletion-design.md`, sections "Mobile" and "Testing". This plan implements only its Mobile portion; the Server portion is already done.

> **Correction (applied during execution).** The test code in Tasks 2 and 3 below omits `await` on `fireEvent` calls. That is a defect in this plan. Under this repo's `@testing-library/react-native` 14.0.1 + React 19.2.3, an un-awaited `fireEvent` does not flush state updates before the next line, so the gate assertions pass against a completely ungated implementation — the tests would be worthless. **Write `await fireEvent.press(...)` / `await fireEvent.changeText(...)`**, matching the repo convention in `app/__tests__/sign-in.test.tsx:69-121` and `meal-undo.test.tsx:141-293`. Verified empirically during Task 2.

## Context an implementer needs

**What already exists and must NOT be rebuilt:**

- `DELETE /v1/me` — `api/internal/server/router.go:137`. Takes no body; the user comes from the auth context. Returns **204** on success. Returns 204 even when Firebase identity deletion fails (deliberate — see the spec's "Why steps 4 and 5 are in that order").
- Ownership transfer, the 17-table cascade, `ai_usage_events` nulling, and Apple refresh-token revocation are all server-side and tested (`api/internal/user/deletion.go`, `ownership.go`, `api/internal/appleid/`).
- Slice 1 (Apple `authorizationCode` capture) is complete on both client and server.

**Nothing in this plan touches Go code or migrations.**

**Key files to read before starting:**

- `apps/mobile/src/api/hooks.ts:832-845` — `setDisplayName` and `storeAppleAuthorization` are the exact pattern for a plain (non-hook) API function.
- `apps/mobile/app/settings.tsx` — 163 lines. The screen this plan modifies.
- `apps/mobile/src/components/GroupedList.tsx` — `GroupedSection` and `Row`. `Row` **already** accepts a `destructive?: boolean` prop that colors the title `instrument.danger`. Do not add it.
- `apps/mobile/app/(tabs)/more.tsx:157-177` — the existing Sign out row: it calls `unregisterPushToken()` inside a best-effort `try/catch`, then `signOut(auth)`. The delete flow mirrors this.
- `apps/mobile/src/lib/push.ts:55-60` — `unregisterPushToken()` reads the cached token, calls `unregisterDevice(token)`, then clears local `AsyncStorage`.
- `apps/mobile/src/lib/apiErrorMessage.ts` — `apiErrorMessage(error: unknown): string`.
- `apps/mobile/app/__tests__/settings.test.tsx` — the harness pattern for testing a screen in this repo.

**Routing:** expo-router is file-based. Creating `app/delete-account.tsx` registers the route automatically. **Do not** add a `Stack.Screen` to `app/_layout.tsx` — entries there exist only to override presentation (modal, animation), and this screen uses the default push presentation.

### Two decisions this plan settles

**1. The `settings.tsx` line-count drift.** The spec says settings.tsx "is 48 lines today, so there is room." It is now 163. It is still well under the 400-line guideline after this change (~185), and the screen is a flat list of independent sections, so a new one adds no coupling. **Decision: keep the row in `settings.tsx` as the spec says. Do not split the file.** A split is unrelated refactoring.

**2. Case sensitivity of the typed confirmation.** The spec says the button requires typing `delete` and its test says "exactly". Taken literally that fails a user whose iOS keyboard autocapitalises the first letter — the gesture would appear broken through no fault of theirs. **Decision: set `autoCapitalize="none"` AND compare `value.trim().toLowerCase() === "delete"`.** This preserves the spec's intent (a deliberate, typed, non-accidental gesture; `delet` and empty are still rejected) without punishing the keyboard. This is recorded here because it is a visible deviation from one word of the spec.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/api/hooks.ts` | Modify (append near `storeAppleAuthorization`, ~line 845) | Add `deleteAccount()` — the sole caller of `DELETE /v1/me` |
| `src/api/__tests__/deleteAccount.test.tsx` | Create | Pins the method and path |
| `app/delete-account.tsx` | Create | Confirmation screen: copy, typed gate, call, sign-out, navigation, error surface |
| `app/__tests__/delete-account.test.tsx` | Create | Gate, success path, failure path |
| `app/settings.tsx` | Modify (add an Account section before the closing `</View>` of the content stack, ~line 143) | Discoverable destructive entry point |
| `app/__tests__/settings.test.tsx` | Modify (append) | The row exists and routes |

---

## Task 1: `deleteAccount()` API function

**Files:**
- Modify: `apps/mobile/src/api/hooks.ts` (append immediately after `storeAppleAuthorization`, which ends ~line 845)
- Test: `apps/mobile/src/api/__tests__/deleteAccount.test.tsx` (create)

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api`.
- Produces: `deleteAccount(): Promise<unknown>` exported from `@/api/hooks`. Task 2 imports this exact name.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/api/__tests__/deleteAccount.test.tsx`:

```tsx
const mockApiFetch = jest.fn();
jest.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }));

import { deleteAccount } from "@/api/hooks";

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(undefined);
});

test("issues DELETE to /v1/me", async () => {
  await deleteAccount();
  expect(mockApiFetch).toHaveBeenCalledWith("/v1/me", { method: "DELETE" });
});

test("sends no body — the server takes the user from the auth context", async () => {
  await deleteAccount();
  const init = mockApiFetch.mock.calls[0][1] as RequestInit;
  expect(init.body).toBeUndefined();
});

test("propagates a rejection so the screen can surface it", async () => {
  const boom = new Error("nope");
  mockApiFetch.mockRejectedValue(boom);
  await expect(deleteAccount()).rejects.toBe(boom);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/api/__tests__/deleteAccount.test.tsx --ci --forceExit`
Expected: FAIL — `deleteAccount` is not exported from `@/api/hooks`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/mobile/src/api/hooks.ts`, directly after the `storeAppleAuthorization` function:

```ts
// Plain function, not a hook: the caller unmounts as a direct result of the
// call succeeding (the screen signs out and navigates away), so there is no
// component left to hold mutation state or a cache to invalidate.
//
// The server takes the user from the auth context — there is no id in the
// request and nothing to forge. Returns 204 with no body.
export function deleteAccount(): Promise<unknown> {
  return apiFetch("/v1/me", { method: "DELETE" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/api/__tests__/deleteAccount.test.tsx --ci --forceExit`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/deleteAccount.test.tsx
git commit -m "feat(mobile): deleteAccount() wrapping DELETE /v1/me"
```

---

## Task 2: The confirmation screen

**Files:**
- Create: `apps/mobile/app/delete-account.tsx`
- Test: `apps/mobile/app/__tests__/delete-account.test.tsx` (create)

**Interfaces:**
- Consumes: `deleteAccount` from `@/api/hooks` (Task 1); `apiErrorMessage` from `@/lib/apiErrorMessage`; `unregisterPushToken` from `@/lib/push`; `auth` from `@/lib/firebase`; `signOut` from `firebase/auth`.
- Produces: the default-exported route component at path `/delete-account`. Task 3 navigates to this exact path.

**Behaviour being built:**

1. Names exactly what is destroyed — logs, saved meals, weight and water history, friends, coach conversations.
2. States it cannot be undone.
3. The button is disabled until `delete` is typed.
4. On press: `unregisterPushToken()` best-effort → `deleteAccount()` → `signOut(auth)` → `router.replace("/sign-in")`.
5. On failure: surface `apiErrorMessage(e)`, re-enable the button, stay on the screen.

**Why `unregisterPushToken()` runs first and is best-effort:** it calls the API (`unregisterDevice`), so it needs a live session — after `deleteAccount()` the token is invalid and it would 401. It also clears the locally cached token from `AsyncStorage`, which matters on a shared device. But push de-registration failing must never block a deletion Apple requires to complete in-app, and the server cascade removes `device_tokens` rows regardless. Identical reasoning to the Sign out row at `app/(tabs)/more.tsx:163-171`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/delete-account.test.tsx`:

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  router: {
    replace: (...a: unknown[]) => mockReplace(...a),
    back: (...a: unknown[]) => mockBack(...a),
  },
}));

const mockDeleteAccount = jest.fn();
jest.mock("@/api/hooks", () => ({ deleteAccount: () => mockDeleteAccount() }));

const mockUnregister = jest.fn();
jest.mock("@/lib/push", () => ({ unregisterPushToken: () => mockUnregister() }));

const mockSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ signOut: (...a: unknown[]) => mockSignOut(...a) }));
jest.mock("@/lib/firebase", () => ({ auth: { name: "fake-auth" } }));

import DeleteAccount from "../delete-account";

beforeEach(() => {
  mockReplace.mockClear();
  mockBack.mockClear();
  mockSignOut.mockClear();
  mockDeleteAccount.mockReset().mockResolvedValue(undefined);
  mockUnregister.mockReset().mockResolvedValue(undefined);
});

test("names what is destroyed and that it is irreversible", async () => {
  const { getByText } = await render(<DeleteAccount />);
  expect(getByText(/cannot be undone/i)).toBeTruthy();
  expect(getByText(/saved meals/i)).toBeTruthy();
  expect(getByText(/coach conversations/i)).toBeTruthy();
});

test("the confirm button does nothing until the word is typed", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  fireEvent.press(getByTestId("confirm-delete"));
  expect(mockDeleteAccount).not.toHaveBeenCalled();

  fireEvent.changeText(getByTestId("confirm-input"), "delet");
  fireEvent.press(getByTestId("confirm-delete"));
  expect(mockDeleteAccount).not.toHaveBeenCalled();
});

test("a capitalised or padded 'Delete' is accepted", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  fireEvent.changeText(getByTestId("confirm-input"), "  Delete ");
  fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));
});

test("success de-registers push, deletes, signs out, then replaces to sign-in", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  fireEvent.changeText(getByTestId("confirm-input"), "delete");
  fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockUnregister).toHaveBeenCalledTimes(1);
  expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalledTimes(1);

  // Order matters: de-registration needs a live session, and sign-out must not
  // happen before the account is actually gone.
  const unregisterOrder = mockUnregister.mock.invocationCallOrder[0];
  const deleteOrder = mockDeleteAccount.mock.invocationCallOrder[0];
  const signOutOrder = mockSignOut.mock.invocationCallOrder[0];
  expect(unregisterOrder).toBeLessThan(deleteOrder);
  expect(deleteOrder).toBeLessThan(signOutOrder);
});

test("a failed push de-registration does not block deletion", async () => {
  mockUnregister.mockRejectedValue(new Error("no token"));
  const { getByTestId } = await render(<DeleteAccount />);
  fireEvent.changeText(getByTestId("confirm-input"), "delete");
  fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
});

test("a failed deletion shows mapped copy, stays put, and does not sign out", async () => {
  const apiError = Object.assign(new Error("boom"), { name: "ApiError", status: 500 });
  mockDeleteAccount.mockRejectedValue(apiError);

  const { getByTestId, getByText } = await render(<DeleteAccount />);
  fireEvent.changeText(getByTestId("confirm-input"), "delete");
  fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() =>
    expect(getByText("Kora is having trouble right now. Please try again in a moment.")).toBeTruthy(),
  );
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

test("the failed request can be retried without retyping", async () => {
  mockDeleteAccount.mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);

  const { getByTestId } = await render(<DeleteAccount />);
  fireEvent.changeText(getByTestId("confirm-input"), "delete");
  fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));

  fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/delete-account.test.tsx --ci --forceExit`
Expected: FAIL — cannot resolve module `../delete-account`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/app/delete-account.tsx`:

```tsx
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { signOut } from "firebase/auth";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { safeBack } from "@/lib/safeBack";
import { deleteAccount } from "@/api/hooks";
import { unregisterPushToken } from "@/lib/push";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { auth } from "@/lib/firebase";
import { useTheme } from "@/theme";

// What the server's cascade actually removes, named in the user's words rather
// than in table names. Kept in sync with the 17 cascading FKs listed in
// docs/superpowers/specs/2026-08-07-account-deletion-design.md.
const DESTROYED = [
  "Your food logs and photos",
  "Saved meals and pinned foods",
  "Weight and water history",
  "Friends, groups and challenges",
  "Coach conversations",
];

const CONFIRM_WORD = "delete";

// Case-insensitive and trimmed: iOS autocapitalises by default, and punishing a
// user for their keyboard would make a working gesture look broken. The typed
// word is still a deliberate act — "delet" and an empty field are both refused.
function isConfirmed(value: string): boolean {
  return value.trim().toLowerCase() === CONFIRM_WORD;
}

export default function DeleteAccountScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = isConfirmed(value);

  const onConfirm = async (): Promise<void> => {
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);

    // Best-effort and FIRST: unregisterDevice needs a live session, and this
    // also clears the locally cached token so a shared device stops receiving
    // the previous user's push. Never allowed to block the deletion itself.
    try {
      await unregisterPushToken();
    } catch {
      // Deliberately swallowed — see src/lib/push.ts for this convention.
    }

    try {
      await deleteAccount();
    } catch (e: unknown) {
      setError(apiErrorMessage(e));
      setPending(false);
      return;
    }

    // The account is gone. A failure past this point must not strand the user
    // on a screen for an account that no longer exists, so sign-out is
    // best-effort and navigation happens regardless.
    try {
      if (auth) await signOut(auth);
    } catch {
      // Deliberately swallowed — the session is dead server-side either way.
    }
    router.replace("/sign-in");
  };

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Account" title="Delete account" onBack={() => safeBack("/settings")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm }}>
            <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
              This deletes your Kora account and everything in it.
            </AppText>
            {DESTROYED.map((line) => (
              <AppText key={line} style={{ fontSize: 14, color: instrument.mut }}>
                {`•  ${line}`}
              </AppText>
            ))}
            <AppText style={{ fontSize: 14, fontWeight: "600", color: instrument.danger }}>
              This cannot be undone.
            </AppText>
          </GlassPanel>

          <View style={{ gap: spacing.xs }}>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md }}>
              Type “delete” to confirm.
            </AppText>
            <GlassPanel radius={22} style={{ paddingHorizontal: spacing.md }}>
              <TextInput
                testID="confirm-input"
                value={value}
                onChangeText={setValue}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!pending}
                placeholder="delete"
                placeholderTextColor={instrument.mut}
                style={{ minHeight: 48, fontSize: 16, color: instrument.ink }}
              />
            </GlassPanel>
          </View>

          {error ? (
            <AppText style={{ fontSize: 14, color: instrument.danger, marginLeft: spacing.md }}>
              {error}
            </AppText>
          ) : null}

          <PressableScale
            testID="confirm-delete"
            accessibilityRole="button"
            accessibilityLabel="Delete my account"
            accessibilityState={{ disabled: !confirmed || pending }}
            haptic="none"
            onPress={onConfirm}
            style={{
              minHeight: 50,
              borderRadius: 16,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: instrument.inset,
              opacity: confirmed && !pending ? 1 : 0.4,
            }}
          >
            <AppText style={{ fontSize: 16, fontWeight: "600", color: instrument.danger }}>
              {pending ? "Deleting…" : "Delete my account"}
            </AppText>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest app/__tests__/delete-account.test.tsx --ci --forceExit`
Expected: PASS, 7 tests.

Both APIs used above are confirmed against the real modules: `src/lib/firebase.ts:18` exports `auth: Auth | null` (hence the `if (auth)` guard), and `PressableScale` spreads `...rest` onto its inner `AnimatedPressable` (`src/motion/PressableScale.tsx:26,38`), so `testID`, `accessibilityRole`, `accessibilityLabel` and `accessibilityState` all pass through.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/delete-account.tsx apps/mobile/app/__tests__/delete-account.test.tsx
git commit -m "feat(mobile): account deletion confirmation screen"
```

---

## Task 3: The Settings entry point

**Files:**
- Modify: `apps/mobile/app/settings.tsx` (add a new section after the "Custom" reminders `View` closes at line 143, still inside the `gap: spacing.lg` stack)
- Modify: `apps/mobile/app/__tests__/settings.test.tsx` (append two tests)

**Interfaces:**
- Consumes: `GroupedSection` and `Row` from `@/components/GroupedList` (both are **already imported** at `app/settings.tsx:11`); `router` from `expo-router`.
- Produces: nothing other tasks depend on. This is the last task.

- [ ] **Step 1: Write the failing test**

Append to `apps/mobile/app/__tests__/settings.test.tsx`:

```tsx
test("offers a destructive Delete account row", async () => {
  const { getByText } = await render(<Settings />);
  expect(getByText("Account")).toBeTruthy();
  expect(getByText("Delete account")).toBeTruthy();
});

test("tapping Delete account routes to the confirmation screen", async () => {
  const { getByText } = await render(<Settings />);
  fireEvent.press(getByText("Delete account"));
  expect(mockPush).toHaveBeenCalledWith("/delete-account");
});
```

The existing `expo-router` mock at the top of this file already exposes `push` as `mockPush` and clears it in `beforeEach` — nothing to add there.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest app/__tests__/settings.test.tsx --ci --forceExit`
Expected: FAIL — `Unable to find an element with text: Account`.

- [ ] **Step 3: Write minimal implementation**

In `apps/mobile/app/settings.tsx`, add the `router` import to the existing `expo-router` usage. The file does not currently import from `expo-router` (it uses `safeBack`), so add at the top with the other imports:

```tsx
import { router } from "expo-router";
```

Then, immediately after the closing `</View>` of the "Custom" reminders block (line 143) and before the closing `</View>` of the `paddingHorizontal: 20` stack (line 144), insert:

```tsx
          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Account
            </AppText>
            <GroupedSection>
              <Row
                title="Delete account"
                destructive
                chevron
                onPress={() => router.push("/delete-account")}
              />
            </GroupedSection>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md, marginTop: spacing.xs }}>
              Permanently deletes your account and all your data.
            </AppText>
          </View>
```

`Row` already supports `destructive`, which colors the title `instrument.danger` — see `src/components/GroupedList.tsx:113`. Do not add styling of your own.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest app/__tests__/settings.test.tsx --ci --forceExit`
Expected: PASS — the pre-existing tests plus the 2 new ones.

- [ ] **Step 5: Run the full suites**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: no type errors; the whole suite green. If an unrelated test broke, fix it — do not skip it.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/settings.tsx apps/mobile/app/__tests__/settings.test.tsx
git commit -m "feat(mobile): delete account row in settings"
```

---

## Definition of done

- [ ] `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] `cd apps/mobile && npx jest --ci --forceExit` green.
- [ ] Settings shows a red "Delete account" row that routes to a confirmation screen.
- [ ] The confirm button does nothing until `delete` is typed.
- [ ] A successful delete signs out and lands on `/sign-in`.
- [ ] A failed delete shows mapped copy and leaves the user signed in.

## Explicitly out of scope

- Anything server-side. It is built, tested and green.
- Encryption at rest for `apple_refresh_token` — a recorded follow-up in the spec.
- A grace period or restore flow — deliberately excluded for R1.
- Data export — that is #24, which stays open and is R3.
- Splitting `settings.tsx` — see decision 1.

## Device verification (cannot be done in CI — carry into #106's closing comment)

The spec requires a physical device against prod, because the Apple path runs through a native module. After this ships:

1. Sign in with Apple, delete the account from Settings, then confirm **by query** that the rows are gone:
   ```sql
   SELECT count(*) FROM users WHERE id = '<uuid>';
   SELECT count(*) FROM food_logs WHERE user_id = '<uuid>';
   ```
2. Confirm the same Apple ID can sign in again and gets a fresh, empty account.
3. Confirm `ai_usage_events` rows for that user survive with `user_id IS NULL`:
   ```sql
   SELECT count(*) FROM ai_usage_events WHERE user_id IS NULL;
   ```
4. Confirm `kora_admin_events` is untouched.

**Note:** production data currently lives on `global-postgres-1` in the `global` namespace, **not** `kora-postgres-1` — the cutover has not landed (see #156). Query the right instance or you will get `relation "users" does not exist` and misread it as a broken migration.
