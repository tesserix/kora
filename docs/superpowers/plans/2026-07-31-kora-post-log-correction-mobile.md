# Post-Log Correction — Mobile Implementation Plan (PR2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Kora user fix a wrong AI food estimate from the diary — change the food, re-ask Kora, or undo — and make the correction actually teach their food index.

**Architecture:** `app/meal.tsx` becomes the correction sheet: it keeps painting instantly from the diary's route params, then reconciles against a real `GET /v1/logs/:id` read that supplies `food_item_id`, `source` and `input_phrase`. Changing the food goes through a free index search (`GET /v1/foods`); "Ask Kora again" is an explicit opt-in that spends one AI call. Undo reverts the log and retracts the alias the correction taught.

**Tech Stack:** Expo SDK 57 (React Native 0.86, React 19.2.3), Expo Router 57, TanStack React Query v5, TypeScript, Jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-07-31-kora-post-log-correction-design.md`
**Backend (already merged, `693a8a7`):** `docs/superpowers/plans/2026-07-31-kora-post-log-correction-backend.md`

## Global Constraints

- **Read https://docs.expo.dev/versions/v57.0.0/ before writing any mobile code.** `apps/mobile/AGENTS.md` requires it. SDK 57 = RN 0.86 + React 19.2.3; Expo Router has no dedicated modal API, so keep using the existing `Sheet` component.
- Run all commands in the **foreground**. Never background a test run.
- Checks: `cd apps/mobile && npx tsc --noEmit && npm test` (83 suites / 400 tests before this plan).
- **The client never sends nutrition.** Only `food_item_id`, grams, slot, timestamps, and phrases. Every kcal/macro comes back from the server.
- UI must sit inside the visual language of `design-system/ui_kits/kora/MealDetail.jsx` (FoodTile, `Overline` section headers, existing `Button` variants). That mockup has **no food-change affordance**, so this is new ground — extend it, don't invent a new idiom.
- `retract_correction: true` may **only** accompany a genuine undo. Sent alongside a forward correction to a different food it deletes the old alias and teaches nothing. Never set it on any path except undo.
- No `console.log`. Explicit types on exported functions and hooks. No `any`.
- Conventional single-line commit messages. No `Co-Authored-By` trailer, no signatures.
- Branch off `main` (currently `693a8a7`). Do **not** stack on another branch.

## Backend contract (merged, do not re-implement)

| Endpoint | Shape |
|---|---|
| `GET /v1/logs/:id` | `{"data": FoodLog}` — includes `food_item_id`, `source`, `input_phrase`. 404 for another user's log. |
| `PATCH /v1/logs/:id` | body `{food_item_id?, meal_slot?, quantity_grams?, logged_at?, retract_correction?}` → `{"data": FoodLog, "meta": {"alias_recorded": bool}}` |
| `DELETE /v1/logs/:id` | `{"data": {"deleted": true}}` |
| `GET /v1/foods?q=` | `{"data": Candidate[]}` — index-only, **no AI cost** |
| `POST /v1/resolve/text` | `{"data": Resolution}` — costs one AI call |
| `POST /v1/resolve/voice` | `Resolution` now carries `transcript` |
| `POST /v1/logs` | `LogRequest` accepts `input_phrase`; server keeps it only when `source` is `ai_text` or `ai_voice` |

Server-side, a food change on a log that has an `input_phrase` teaches a personal alias and evicts that user's cached resolution for the phrase. `retract_correction` un-teaches it.

## Two gaps the spec understated — both are in this plan

1. **`apiFetch` discards `meta`.** `src/lib/api.ts:34` returns `body.data ?? body`, so `alias_recorded` is unreachable today. Task 1 adds an envelope-aware sibling.
2. **Nothing populates `input_phrase`.** `capture.tsx:762` calls `setText("")` immediately after resolving, so by the time logs are created the phrase is gone. Without Task 2 the backend column stays NULL forever and the entire correction loop is inert.

---

### Task 1: API client plumbing

**Files:**
- Modify: `apps/mobile/src/lib/api.ts` (add `apiFetchEnvelope`)
- Modify: `apps/mobile/src/api/types.ts` (`FoodLog.input_phrase`, `Resolution.transcript`)
- Modify: `apps/mobile/src/api/hooks.ts` (`EditLogInput`, `useEditLog`, `useLog`, `useFoodSearch`)
- Test: `apps/mobile/src/api/__tests__/hooks.test.tsx` (extend)

**Interfaces:**
- Consumes: the merged backend contract above.
- Produces:
  - `export async function apiFetchEnvelope<T>(path: string, init?: RequestInit): Promise<{ data: T; meta?: Record<string, unknown> }>`
  - `FoodLog.input_phrase?: string`
  - `Resolution.transcript?: string`
  - `EditLogInput` gains `food_item_id?: string` and `retract_correction?: boolean`
  - `useEditLog()` whose `mutateAsync`/`onSuccess` payload is `{ log: FoodLog; aliasRecorded: boolean }`
  - `useLog(id: string)` → `UseQueryResult<FoodLog>`
  - `useFoodSearch(query: string)` → `UseQueryResult<Candidate[]>`

Tasks 3–5 consume all of these.

- [ ] **Step 1: Write the failing tests**

Append to `apps/mobile/src/api/__tests__/hooks.test.tsx`, following the `wrapper`/`renderHook` pattern already used there:

```tsx
test("useLog GETs /v1/logs/:id and returns the full record", async () => {
  mockFetchOnce({ data: { id: "log1", food_item_id: "f1", source: "ai_text", input_phrase: "brekkie eggs", description: "Scrambled eggs" } });
  const { result } = await renderHook(() => useLog("log1"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v1/logs/log1"), expect.anything());
  expect(result.current.data?.input_phrase).toBe("brekkie eggs");
});

test("useFoodSearch hits /v1/foods with the query and stays disabled under 2 chars", async () => {
  const { result: idle } = await renderHook(() => useFoodSearch("q"), { wrapper });
  expect(idle.current.fetchStatus).toBe("idle");
  expect(fetchMock).not.toHaveBeenCalled();

  mockFetchOnce({ data: [{ item: { id: "f2", name: "Quinoa" }, match_score: 0.9, match_tier: "fulltext" }] });
  const { result } = await renderHook(() => useFoodSearch("quinoa"), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/v1/foods?q=quinoa"), expect.anything());
});

test("useEditLog surfaces meta.alias_recorded alongside the updated log", async () => {
  mockFetchOnce({ data: { id: "log1", food_item_id: "f2" }, meta: { alias_recorded: true } });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  const out = await result.current.mutateAsync({ id: "log1", food_item_id: "f2" });
  expect(out.aliasRecorded).toBe(true);
  expect(out.log.food_item_id).toBe("f2");
});

test("useEditLog reports aliasRecorded false when the server omits meta", async () => {
  mockFetchOnce({ data: { id: "log1" } });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  const out = await result.current.mutateAsync({ id: "log1", quantity_grams: 200 });
  expect(out.aliasRecorded).toBe(false);
});

test("useEditLog forwards retract_correction when set", async () => {
  mockFetchOnce({ data: { id: "log1" }, meta: { alias_recorded: false } });
  const { result } = await renderHook(() => useEditLog(), { wrapper });
  await result.current.mutateAsync({ id: "log1", food_item_id: "f1", retract_correction: true });
  const body = JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body as string);
  expect(body).toEqual({ food_item_id: "f1", retract_correction: true });
  expect(body.id).toBeUndefined();
});
```

Read the top of the existing test file first and reuse its fetch-mocking helper; if it mocks `global.fetch` inline rather than via a `mockFetchOnce` helper, add that helper rather than inventing a second mocking style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/mobile && npm test -- src/api/__tests__/hooks.test.tsx`
Expected: FAIL — `useLog` and `useFoodSearch` are not exported, and `mutateAsync` resolves to a bare `FoodLog` with no `aliasRecorded`.

- [ ] **Step 3: Add the envelope-aware fetch**

In `apps/mobile/src/lib/api.ts`, after `apiFetch`, add:

```ts
// apiFetch unwraps to `data` and drops everything else, which is right for
// almost every endpoint. PATCH /v1/logs/:id also returns a `meta` object
// saying whether the correction taught the food index — the client must not
// claim "Kora will remember" for a best-effort write that failed — so this
// sibling returns the whole envelope. Same auth and error handling.
export async function apiFetchEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const user = auth?.currentUser;
  const token = user ? await user.getIdToken() : null;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? "unknown", body.message ?? "request failed");
  }
  return (await res.json()) as { data: T; meta?: Record<string, unknown> };
}
```

- [ ] **Step 4: Extend the types**

In `apps/mobile/src/api/types.ts`, add to `FoodLog` after `provenance`:

```ts
  /** What the user actually said or typed. Present only on ai_text/ai_voice logs. */
  input_phrase?: string;
```

and to `Resolution`:

```ts
  /** Speech-to-text transcript, present only on a successful voice resolve. */
  transcript?: string;
```

- [ ] **Step 5: Add and extend the hooks**

In `apps/mobile/src/api/hooks.ts`, replace `EditLogInput` and `useEditLog` with:

```ts
export type EditLogInput = {
  id: string;
  meal_slot?: MealSlot;
  quantity_grams?: number;
  food_item_id?: string;
  /**
   * Undo only. Retracts the alias a previous correction on this log taught.
   * Never send this alongside a forward correction to a different food — the
   * server would delete the old alias and teach nothing.
   */
  retract_correction?: boolean;
};

export type EditLogResult = { log: FoodLog; aliasRecorded: boolean };

export function useEditLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: EditLogInput): Promise<EditLogResult> => {
      const envelope = await apiFetchEnvelope<FoodLog>(`/v1/logs/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { log: envelope.data, aliasRecorded: envelope.meta?.alias_recorded === true };
    },
    onSuccess: (_result, { id }) => {
      qc.invalidateQueries({ queryKey: ["logs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["log", id] });
      // A correction changes what the food index returns for this user, so
      // memory and any cached resolve result are stale too.
      qc.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}

export function useLog(id: string) {
  return useQuery({
    queryKey: ["log", id],
    queryFn: () => apiFetch(`/v1/logs/${id}`) as Promise<FoodLog>,
    enabled: id.length > 0,
  });
}

// Index-only search — alias, then full-text, then embedding. No AI cost, so
// it is safe to call as the user types. Disabled under 2 characters because
// the server rejects shorter queries with a 400.
export function useFoodSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["foods", q],
    queryFn: () => apiFetch(`/v1/foods?q=${encodeURIComponent(q)}`) as Promise<Candidate[]>,
    enabled: q.length >= 2,
  });
}
```

Add `apiFetchEnvelope` to the `@/lib/api` import, and `Candidate` to the `@/api/types` import.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/mobile && npm test -- src/api/__tests__/hooks.test.tsx`
Expected: PASS. Existing `useEditLog` tests in that file will fail to compile against the new result shape — update their call sites to read `result.log`, and do **not** drop what they assert.

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/mobile && npx tsc --noEmit
git add apps/mobile/src/lib/api.ts apps/mobile/src/api/types.ts apps/mobile/src/api/hooks.ts apps/mobile/src/api/__tests__/hooks.test.tsx
git commit -m "feat(mobile): read the correction envelope and add log/food-search hooks"
```

---

### Task 2: Send `input_phrase` when a resolve-sourced log is created

**Files:**
- Modify: `apps/mobile/app/capture.tsx`
- Modify: `apps/mobile/src/api/hooks.ts` (`CreateLogInput`)
- Test: `apps/mobile/app/__tests__/capture-input-phrase.test.tsx` (create)

**Interfaces:**
- Consumes: `Resolution.transcript` (Task 1).
- Produces: logs whose `input_phrase` is populated. **Every later task depends on this** — without it `input_phrase` is always NULL and nothing in the correction loop can teach the index.

- [ ] **Step 1: Read the current flow**

Read `apps/mobile/app/capture.tsx` around lines 660–900. Note two facts that shape this task:
- `const [text, setText] = useState("")` at ~678, and `setText("")` at ~762 immediately after a successful resolve — so the typed phrase is **gone** by the time `onAdd` runs at ~855.
- `sourceForMode(mode)` at ~297 returns `ai_text`, `ai_voice`, `ai_photo` or `ai_barcode`. Only the first two may carry a phrase; the server drops it for the others regardless, but the client should not send what it knows is meaningless.

- [ ] **Step 2: Write the failing test**

Create `apps/mobile/app/__tests__/capture-input-phrase.test.tsx`. Mirror the mocking style of the existing `app/__tests__/` capture tests (read one first — reuse its `expo-router` and `@/api/hooks` mocks rather than inventing new ones):

```tsx
test("a typed resolve logs the phrase the user actually typed", async () => {
  // resolve "brekkie eggs" -> one candidate, then add to diary
  // assert createLog was called with input_phrase: "brekkie eggs" and source: "ai_text"
});

test("a voice resolve logs the server's transcript", async () => {
  // resolution.transcript = "two boiled eggs"
  // assert createLog was called with input_phrase: "two boiled eggs" and source: "ai_voice"
});

test("a photo resolve sends no input_phrase", async () => {
  // assert the createLog payload has no input_phrase key
});
```

Fill each body in with real assertions against `mockCreateLogMutate.mock.calls` — the comments above are the required cases, not placeholders to leave in the file.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/mobile && npm test -- app/__tests__/capture-input-phrase.test.tsx`
Expected: FAIL — no `input_phrase` is sent on any path.

- [ ] **Step 4: Retain the phrase and send it**

In `capture.tsx`, add state beside `text`:

```tsx
  // The phrase that produced the current resolution. `text` is cleared as soon
  // as the resolve fires, so it cannot be read at add-to-diary time — but the
  // correction loop needs the exact words the user used, since that is the key
  // a later correction teaches the food index under.
  const [resolvedPhrase, setResolvedPhrase] = useState<string | null>(null);
```

Set it on each resolve path:
- text: in the `resolveText.mutate(phrase, { onSuccess: ... })` handler, `setResolvedPhrase(phrase)` **before** `setText("")`.
- voice: `setResolvedPhrase(data.transcript ?? null)` in the voice `onSuccess`.
- photo and barcode: `setResolvedPhrase(null)`.

Clear it wherever `resolution` is reset, so a stale phrase can never attach to a later, unrelated log.

Add to the `createLog.mutateAsync({...})` payload in `onAdd`:

```tsx
          ...(resolvedPhrase && (source === "ai_text" || source === "ai_voice")
            ? { input_phrase: resolvedPhrase }
            : {}),
```

- [ ] **Step 5: Add the field to `CreateLogInput`**

In `apps/mobile/src/api/hooks.ts`, add to `CreateLogInput`:

```ts
  /** Raw user phrase; the server keeps it only for ai_text / ai_voice sources. */
  input_phrase?: string;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/mobile && npm test -- app/__tests__/capture-input-phrase.test.tsx`
Expected: PASS on all three.

- [ ] **Step 7: Prove the test is load-bearing**

Temporarily delete the whole `...(resolvedPhrase && ...)` spread from the payload. Run the same command. Expected: the text and voice tests **FAIL**; the photo test still passes. Restore and re-confirm PASS. Reverting only the `source ===` condition is a weaker proof — remove the entire spread.

- [ ] **Step 8: Full check and commit**

```bash
cd apps/mobile && npx tsc --noEmit && npm test
git add apps/mobile/app/capture.tsx apps/mobile/src/api/hooks.ts apps/mobile/app/__tests__/capture-input-phrase.test.tsx
git commit -m "feat(mobile): send the user's phrase when logging a resolved food"
```

---

### Task 3: Correction sheet reads the real log and can change the food

**Files:**
- Modify: `apps/mobile/app/meal.tsx`
- Create: `apps/mobile/src/components/meal/FoodPicker.tsx`
- Test: `apps/mobile/app/__tests__/meal-change-food.test.tsx` (create)

**Interfaces:**
- Consumes: `useLog`, `useFoodSearch`, `EditLogInput.food_item_id` (Task 1).
- Produces: `FoodPicker` (props below), and a `meal.tsx` that holds the fetched `FoodLog`. Tasks 4 and 5 extend the same screen.

```tsx
interface FoodPickerProps {
  visible: boolean;
  initialQuery: string;
  onSelect: (item: FoodItem) => void;
  onClose: () => void;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/meal-change-food.test.tsx`, mirroring the mocks in the existing `app/__tests__/meal.test.tsx` (read it first — it mocks `expo-router` and `@/api/hooks`, and passes the meal fields as route params):

```tsx
test("tapping the food name opens a picker and selecting PATCHes food_item_id", async () => {
  // useLog returns { id: "log1", food_item_id: "f1", source: "ai_text", input_phrase: "brekkie eggs", ... }
  // useFoodSearch returns [{ item: { id: "f2", name: "Quinoa" }, ... }]
  // press the food name row -> type "quinoa" -> press "Quinoa"
  // expect mockEditMutate called with { id: "log1", food_item_id: "f2" }
  // and NOT carrying retract_correction
});

test("the sheet paints from route params before the fetch resolves", async () => {
  // useLog returns { data: undefined, isLoading: true }
  // expect the route-param name to be on screen, and no blank/spinner-only state
});
```

Replace the comments with real assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-change-food.test.tsx`
Expected: FAIL — the food name is not pressable and no picker exists.

- [ ] **Step 3: Build `FoodPicker`**

Create `apps/mobile/src/components/meal/FoodPicker.tsx`. Requirements:
- A `Sheet` (same component `meal.tsx` uses) containing a text input and a results list.
- Results come from `useFoodSearch(query)`, seeded with `initialQuery`.
- Each row: `FoodTile`-style icon via `foodVisual(name)`, the food name, and its `kcal_per_100g` rendered verbatim as `N kcal/100g` — **never** a portion-scaled number, which would be a client-computed nutrition value.
- Empty state when the query is ≥2 chars and returns nothing: "No match — try another word."
- Under 2 chars: a hint, not a spinner, since the query is disabled.
- Error state: an inline message; the sheet stays open with the prior value intact.
- Every pressable has an `accessibilityLabel`.

Use `Overline` for the section header and the existing `Button` variants, per the mockup's visual language.

- [ ] **Step 4: Wire it into `meal.tsx`**

- Call `const { data: log } = useLog(p.id)`.
- Keep painting from `p.*` route params; prefer `log` fields when present. Never blank the sheet while loading.
- Make the food name row a `Pressable` with `accessibilityLabel="Change food"` that opens the picker with `initialQuery` = `log?.input_phrase ?? name`.
- On select: `editLog.mutate({ id: p.id, food_item_id: item.id }, ...)`, close the picker, and let the server's response drive the displayed macros — do not recompute them locally.
- Keep the existing portion/slot/save/repeat/delete behaviour working unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-change-food.test.tsx app/__tests__/meal.test.tsx`
Expected: PASS, including the pre-existing `meal.test.tsx` — it must not regress. If it breaks because `useLog` is now called, add `useLog` to its `@/api/hooks` mock; do not weaken its assertions.

- [ ] **Step 6: Full check and commit**

```bash
cd apps/mobile && npx tsc --noEmit && npm test
git add apps/mobile/app/meal.tsx apps/mobile/src/components/meal/FoodPicker.tsx apps/mobile/app/__tests__/meal-change-food.test.tsx
git commit -m "feat(mobile): change a logged food from the correction sheet"
```

---

### Task 4: "Ask Kora again"

**Files:**
- Modify: `apps/mobile/app/meal.tsx`
- Create: `apps/mobile/src/components/meal/AskAgainSheet.tsx`
- Test: `apps/mobile/app/__tests__/meal-ask-again.test.tsx` (create)

**Interfaces:**
- Consumes: `useResolveText` (existing), `useLog` and the picker plumbing from Task 3.
- Produces: `AskAgainSheet` with the same prop shape as `FoodPicker` plus `phrase: string`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/meal-ask-again.test.tsx`:

```tsx
test("Ask Kora again is hidden when the log has no input_phrase", async () => {
  // useLog returns a manual log: input_phrase undefined
  // expect queryByLabelText("Ask Kora again") to be null
});

test("Ask Kora again is shown for an ai_text log and re-resolves the edited phrase", async () => {
  // useLog returns input_phrase: "brekkie eggs"
  // press "Ask Kora again" -> the input is prefilled with "brekkie eggs"
  // edit it to "scrambled eggs" -> submit
  // expect mockResolveTextMutate called with "scrambled eggs"
});

test("choosing a candidate from the re-run PATCHes that food", async () => {
  // resolution has one candidate f9
  // expect mockEditMutate called with { id: "log1", food_item_id: "f9" }
});
```

Replace the comments with real assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-ask-again.test.tsx`
Expected: FAIL — no such control exists.

- [ ] **Step 3: Build `AskAgainSheet`**

Create `apps/mobile/src/components/meal/AskAgainSheet.tsx`:
- A `Sheet` with a text input prefilled from `phrase`, and a submit button.
- Submitting calls `useResolveText`. Show a pending state — this one costs an AI call, so the user must see it working.
- Render the returned `resolution.candidates` in the same presentation `capture.tsx` uses. If `DetectedCard` cannot be reused without dragging in its meal-slot pills and add-to-diary button, render a plain candidate list styled to match rather than bending `DetectedCard` to two masters — say which you chose and why in your report.
- `tier === "follow_up"`: show `follow_up_question` and offer manual search instead. Do not log anything.
- Zero candidates: "Kora couldn't identify that" plus the manual-search fallback.
- Failure: inline error; the log is left untouched.

- [ ] **Step 4: Wire it into `meal.tsx`**

Render the "Ask Kora again" button **only** when `log?.input_phrase` is a non-empty string. A manual, memory, photo or barcode log has no phrase, so there is nothing to re-ask about. Selecting a candidate PATCHes `food_item_id` exactly as the picker does.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-ask-again.test.tsx`
Expected: PASS on all three.

- [ ] **Step 6: Prove the gating is load-bearing**

Temporarily change the render condition to always-true. Run the same command. Expected: the "hidden when the log has no input_phrase" test **FAILS**. Restore and re-confirm PASS.

- [ ] **Step 7: Full check and commit**

```bash
cd apps/mobile && npx tsc --noEmit && npm test
git add apps/mobile/app/meal.tsx apps/mobile/src/components/meal/AskAgainSheet.tsx apps/mobile/app/__tests__/meal-ask-again.test.tsx
git commit -m "feat(mobile): re-ask Kora about a logged food on demand"
```

---

### Task 5: Undo for edits and deletes

**Files:**
- Modify: `apps/mobile/app/meal.tsx`
- Test: `apps/mobile/app/__tests__/meal-undo.test.tsx` (create)

**Interfaces:**
- Consumes: `useToast` (existing — `{ message, actionLabel, onAction }`), `EditLogResult.aliasRecorded`, `EditLogInput.retract_correction`, `useCreateLog`.
- Produces: the finished correction loop. Nothing else consumes this.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/app/__tests__/meal-undo.test.tsx`:

```tsx
test("a correction that taught the index offers Undo and retracts on tap", async () => {
  // editLog resolves { log: {...}, aliasRecorded: true }
  // expect toast.show called with actionLabel "Undo" and a message mentioning Kora will remember
  // invoke onAction
  // expect mockEditMutate's second call to be { id: "log1", food_item_id: <ORIGINAL f1>, retract_correction: true }
});

test("a correction that taught nothing undoes without retract_correction", async () => {
  // aliasRecorded: false
  // invoke onAction
  // expect the undo payload to have no retract_correction key
});

test("deleting offers Undo which re-creates the log", async () => {
  // invoke the delete toast's onAction
  // expect mockCreateLogMutate called with the retained food_item_id, grams, slot and logged_at
});
```

Replace the comments with real assertions. The first test is the important one: it pins that the undo reverts to the **original** food id, not the corrected one.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-undo.test.tsx`
Expected: FAIL — no toast is shown after an edit, and delete navigates back without one.

- [ ] **Step 3: Implement undo**

In `meal.tsx`:
- Before mutating, capture the prior values (`food_item_id`, `quantity_grams`, `meal_slot`, `logged_at`) from the fetched `log`.
- On edit success:
  ```tsx
  toast.show({
    message: aliasRecorded ? `Updated · Kora will remember "${phrase}"` : "Updated",
    actionLabel: "Undo",
    onAction: () => editLog.mutate({
      id: p.id,
      food_item_id: prior.food_item_id,
      quantity_grams: prior.quantity_grams,
      meal_slot: prior.meal_slot,
      ...(aliasRecorded ? { retract_correction: true } : {}),
    }),
  });
  ```
  `retract_correction` goes **only** on this undo path and **only** when the edit actually taught something. It must never accompany a forward correction.
- On delete success: show `"Removed"` with an Undo that re-POSTs the retained record via `useCreateLog`. Preserve `input_phrase` in the re-create so a later correction on the restored log can still teach the index.
- Keep the existing `haptics.success()` / `haptics.error()` calls.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/mobile && npm test -- app/__tests__/meal-undo.test.tsx`
Expected: PASS on all three.

- [ ] **Step 5: Prove the retract gating is load-bearing**

Temporarily make `retract_correction: true` unconditional on the undo path. Run the same command. Expected: the "undoes without retract_correction" test **FAILS**. Restore and re-confirm PASS. This one matters: sending the flag when nothing was taught deletes an alias a different log may have created.

- [ ] **Step 6: Full check and commit**

```bash
cd apps/mobile && npx tsc --noEmit && npm test
git add apps/mobile/app/meal.tsx apps/mobile/app/__tests__/meal-undo.test.tsx
git commit -m "feat(mobile): undo a correction and retract what it taught"
```

---

### Task 6: End-to-end check against the live API, then PR

**Files:** none modified (unless the run surfaces a defect).

- [ ] **Step 1: Full check**

```bash
cd apps/mobile && npx tsc --noEmit && npm test
```
Expected: 0 failures. Report the suite/test counts against the 83/400 baseline.

- [ ] **Step 2: Manual pass against the live API**

The simulator needs a signed-in user, and the correction loop only works against real data.

```bash
cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npm run ios
```

This is a **dev build** (native modules are present), so `npm run ios` is required — Expo Go will not work.

Walk the loop and report what you actually saw at each step:
1. Log something by typing a phrase.
2. Open it from the diary; confirm the sheet shows the food and that "Ask Kora again" is present.
3. Change the food; confirm macros update and the toast appears.
4. Type the same phrase again; confirm it now resolves to the corrected food. **This is the payoff — if it still resolves to the old food, the cache eviction or the alias write is not working and this is a blocker, not a nit.**
5. Undo; confirm the log reverts and the phrase stops resolving to the corrected food.

If you cannot run a simulator, say so plainly and report BLOCKED rather than claiming an untested pass.

- [ ] **Step 3: Open the PR**

```bash
gh auth switch --user mahesh-sangawar
git push -u origin HEAD
gh pr create --title "feat(mobile): post-log correction UI" --body "..."
```

Body should cover: what the user can now do; that `capture.tsx` now sends `input_phrase` (without which the merged backend loop was inert); the `apiFetchEnvelope` addition and why `apiFetch` could not be changed; the `retract_correction` rule; and the manual test results from step 2. Refs #20.

- [ ] **Step 4: Report the PR URL and CI status. Do not merge.**

---

## Self-Review

**Spec coverage**

| Spec (Mobile section) | Task |
|---|---|
| `useLog(id)` reconciles route params | 1, 3 |
| `useFoodSearch` over `GET /foods?q=` | 1, 3 |
| Food name row tappable → picker | 3 |
| "Ask Kora again" only when `input_phrase` is set | 4 |
| Candidates in `capture.tsx`'s presentation | 4 |
| Undo toast reverting log + `retract_correction` | 5 |
| Delete-undo re-POSTs the record | 5 |
| Design fidelity to `MealDetail.jsx`'s language | 3, 4 |
| `retract_correction` only on undo | 5 (proven in step 5) |

Two items are in this plan but **not** in the spec's mobile section, because they were found during planning and the feature is inert without them: `apiFetchEnvelope` (Task 1 — `apiFetch` discards `meta`) and `capture.tsx` sending `input_phrase` (Task 2 — the phrase is cleared before logs are created). The spec should be updated to mention both when this merges.

**Placeholder scan:** every code step carries real code, and every command carries an expected result. Three test files (Tasks 2, 3, 4, 5 step 1) give the required cases as comments to be filled with real assertions rather than full bodies — deliberate, because each needs to mirror mocking conventions in a neighbouring test file that the implementer must read first, and inventing a second mocking style would be worse than reusing theirs. Each names its exact cases and expected calls, so nothing is left to taste.

**Type consistency:** `EditLogResult = { log, aliasRecorded }` is defined in Task 1 and consumed in Tasks 3–5. `EditLogInput` carries `food_item_id` and `retract_correction` from Task 1 onward. `FoodLog.input_phrase` and `Resolution.transcript` are both optional strings, declared in Task 1 and read in Tasks 2–5. `FoodPickerProps` (Task 3) and `AskAgainSheet`'s props (Task 4) share the `visible`/`onSelect`/`onClose` shape, with `AskAgainSheet` adding `phrase`.
