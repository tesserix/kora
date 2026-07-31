# Kora Feedback — Mobile UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a beta user file a bug report or feature request from inside Kora, in two taps from the More tab.

**Architecture:** A pushed stack route `app/feedback.tsx` reached from a new row in the More tab, posting to `POST /v1/feedback` (already shipped). Client context — app version, platform, OS version, device model — is collected automatically rather than asked for, because a user cannot reliably report it and it is what makes a bug actionable.

**Tech Stack:** Expo Router 57, React Native 0.86, TanStack Query v5, `apiFetch` from `@/lib/api`, `expo-device` + `expo-constants`.

## Global Constraints

- **`apps/mobile/AGENTS.md` requires reading `https://docs.expo.dev/versions/v57.0.0/` before writing code.** Expo APIs have changed; do not write from memory of older versions.
- Reuse existing components. Do NOT introduce a new UI vocabulary: `ScreenHeader`, `Segmented`, `Button`, `AppText`, `Card`, `AppBackground`, `GroupedSection` / `Row` all exist and are already themed.
- Colours, spacing, radii and shadows come from `useTheme()`. No hardcoded hex values.
- TypeScript: explicit types on exported functions, named `interface`/`type` for props, no `any`. Match the repo's TS style rules.
- No `console.log`.
- The API contract is fixed and already deployed-shaped: `POST /v1/feedback` with `{kind, subject, description, app_version, platform, os_version, device_model}`. `kind` is `"bug"` or `"feature"`. Response is `{"data": {...}}` (httpx envelope).
- Server caps: subject 200 chars, description 4000. Enforce the same limits client-side so a user is never surprised by a rejection they could have been warned about.
- Run tests in the FOREGROUND.
- Single-line conventional-commit messages, no body, no `Co-Authored-By`, no signature.
- Branch `kora-feedback` (already checked out — the backend is on it).

---

### Task 1: API types and hook

**Files:**
- Modify: `apps/mobile/src/api/types.ts`
- Modify: `apps/mobile/src/api/hooks.ts`

**Interfaces:**
- Produces:
  - `type FeedbackKind = "bug" | "feature"`
  - `interface SubmitFeedbackInput { kind: FeedbackKind; subject: string; description: string; app_version: string; platform: string; os_version: string; device_model: string }`
  - `interface FeedbackCreated { id: string; status: string }`
  - `useSubmitFeedback(): UseMutationResult<FeedbackCreated, Error, SubmitFeedbackInput>`

- [ ] **Step 1: Add the types**

In `apps/mobile/src/api/types.ts`, following the file's existing style:

```ts
export type FeedbackKind = "bug" | "feature";

/** Request body for POST /v1/feedback. Snake_case matches the API contract. */
export interface SubmitFeedbackInput {
  kind: FeedbackKind;
  subject: string;
  description: string;
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
}

/** What POST /v1/feedback returns inside the `data` envelope. */
export interface FeedbackCreated {
  id: string;
  status: string;
}
```

- [ ] **Step 2: Add the hook**

In `apps/mobile/src/api/hooks.ts`, add the imports to the existing `./types` import list and append the hook. Match `useSubmitOnboarding`'s shape:

```ts
export function useSubmitFeedback() {
  return useMutation({
    mutationFn: (input: SubmitFeedbackInput) =>
      apiFetch("/v1/feedback", {
        method: "POST",
        body: JSON.stringify(input),
      }) as Promise<FeedbackCreated>,
  });
}
```

No cache invalidation: nothing in the app reads feedback back, so there is no query to invalidate.

- [ ] **Step 3: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts
git commit -m "feat(mobile): add feedback submission types and hook"
```

---

### Task 2: Device context helper

Client context is gathered, never asked for. Isolating it in one tiny module keeps the screen testable without mocking native modules.

**Files:**
- Create: `apps/mobile/src/lib/deviceContext.ts`
- Test: `apps/mobile/src/lib/__tests__/deviceContext.test.ts`

**Interfaces:**
- Produces: `deviceContext(): { app_version: string; platform: string; os_version: string; device_model: string }`

- [ ] **Step 1: Write the failing test**

The point of the test is that every field is a string and nothing throws when a native value is unavailable — on a simulator or an unusual device, any of these can be `null`.

```ts
import { deviceContext } from "../deviceContext";

describe("deviceContext", () => {
  it("returns string values for every field", () => {
    const ctx = deviceContext();

    expect(typeof ctx.app_version).toBe("string");
    expect(typeof ctx.platform).toBe("string");
    expect(typeof ctx.os_version).toBe("string");
    expect(typeof ctx.device_model).toBe("string");
  });

  it("never returns null or undefined even when native values are missing", () => {
    const ctx = deviceContext();

    for (const value of Object.values(ctx)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
  });
});
```

Check `apps/mobile/jest.setup.js` for how native modules are mocked in this repo and follow it. If `expo-device` needs a mock, add one there rather than inside the test.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/mobile && npm test -- deviceContext`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read the Expo 57 docs for `expo-device` and `expo-constants` before writing this — confirm the current field names rather than assuming.

```ts
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

/** Client context attached to a feedback submission.
 *  Every field is coerced to a string: expo-device returns null on some
 *  simulators and unusual devices, and the API rejects non-strings. */
export function deviceContext(): {
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
} {
  return {
    app_version: Constants.expoConfig?.version ?? "",
    platform: Platform.OS,
    os_version: Device.osVersion ?? "",
    device_model: Device.modelName ?? "",
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/mobile && npm test -- deviceContext`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/lib/deviceContext.ts apps/mobile/src/lib/__tests__/deviceContext.test.ts
git commit -m "feat(mobile): collect device context for feedback reports"
```

---

### Task 3: The feedback screen and its entry point

**Files:**
- Create: `apps/mobile/app/feedback.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx`
- Test: `apps/mobile/app/__tests__/feedback.test.tsx`

**Interfaces:**
- Consumes: `useSubmitFeedback` (Task 1), `deviceContext` (Task 2).
- Produces: the `/feedback` route.

- [ ] **Step 1: Write the failing tests**

Look at the existing tests in `apps/mobile/app/__tests__/` for the render/mocking idiom and follow it. Cover:

```
renders both kind options and defaults to "bug"
submit is disabled until subject and description are both non-empty
whitespace-only subject keeps submit disabled
submits kind, subject, description and the device context
shows a success state after a successful submit
shows an inline error and keeps the entered text after a failed submit
enforces the subject and description length caps
```

The failure case matters most: a user who wrote three paragraphs and hit a network error must not lose them. Assert the text is still present after the failure.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/mobile && npm test -- feedback`

Expected: FAIL — module not found.

- [ ] **Step 3: Build the screen**

`apps/mobile/app/feedback.tsx`. Structure, using existing components only:

- `<AppBackground />` and a `<ScreenHeader title="Send feedback" onBack={() => router.back()} />`, matching `app/reminders.tsx`.
- A `<Segmented>` with `options={[{key:"bug",label:"Something's broken"},{key:"feature",label:"I have an idea"}]}`. Plain-language labels, not "Bug"/"Feature" — a beta user is not filing a Jira ticket.
- A single-line subject input, placeholder e.g. `"What's it about?"`, `maxLength={200}`.
- A multiline description input, `maxLength={4000}`, `textAlignVertical="top"`, a reasonable min height, placeholder that prompts for specifics (for a bug: what happened, what you expected).
- A remaining-character hint for the description once it is close to the cap — not a permanent counter.
- A `<Button title="Send" />`, disabled while either field is empty (after trimming) or while the mutation is pending; title reflects the pending state.
- On success: replace the form with a short thank-you and a "Done" button that calls `router.back()`. Do not auto-dismiss — the user should see it landed.
- On error: an inline message above the button in `colors.destructive`, with the entered text preserved and the button re-enabled to retry.
- Wrap the content in a `KeyboardAvoidingView` and a `ScrollView` so the description field is reachable with the keyboard up. Check the Expo 57 / RN 0.86 docs for the current recommended approach.
- Use `useSafeAreaInsets()` for top/bottom padding as sibling screens do.

Accessibility: the segmented control and inputs need accessible labels; the send button needs an `accessibilityLabel` and an `accessibilityState` reflecting `disabled`.

- [ ] **Step 4: Add the entry point**

In `apps/mobile/app/(tabs)/more.tsx`, add a row to the second `GroupedSection` (the one with Settings and Reminders), after Reminders:

```tsx
          <Row
            title="Send feedback"
            icon={{ name: "message", tint: colors.accent }}
            chevron
            onPress={() => router.push("/feedback" as Href)}
          />
```

Check `src/components/Icon.tsx` for the available icon names and pick an existing one — do not invent a name. If nothing suitable exists, use the closest and say which in your report.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd apps/mobile
npx tsc --noEmit
npm test
```

Expected: typecheck clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/app/feedback.tsx apps/mobile/app/__tests__/feedback.test.tsx "apps/mobile/app/(tabs)/more.tsx"
git commit -m "feat(mobile): add the send-feedback screen and More tab entry"
```

---

## Done criteria

- `npx tsc --noEmit` clean; `npm test` green.
- A user reaches feedback in two taps: More → Send feedback.
- Both kinds submit successfully, with device context attached automatically.
- A failed submit preserves what the user typed and offers a retry.
- Client-side limits match the server's (200 / 4000), so a rejection is never a surprise.
- Only existing themed components are used; no hardcoded colours.
