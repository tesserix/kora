# Multi-Ingredient Meal Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user build one saved meal out of several foods — "200 ml milk + 1 mocha portion" — instead of logging each separately, and log it back in the units it was saved in.

**Architecture:** Extend the surfaces that already exist. `SavedMealSheet` (mounted globally by `SavedMealSheetProvider`) gains two new seed modes and an add-ingredient row driven by the existing `FoodPicker`. The diary gains a long-press multi-select that feeds the same sheet. Server-side, `BatchItem` gains the entered pair and resolves it through the same `units.ResolveEntered` helper `LogFood` uses.

**Tech Stack:** Go 1.26, Gin, GORM, testify · Expo/React Native, TypeScript, jest, @testing-library/react-native

**Spec:** `docs/superpowers/specs/2026-08-10-kora-multi-ingredient-meals-design.md`

## Global Constraints

- **Nutrition is computed from `quantity_grams` × the row's per-100 figures, SERVER-SIDE, ALWAYS.** No task may derive kcal or macros on the client. Deriving a *quantity* client-side is allowed.
- A unit resolves to `quantity_grams` exactly **once, at write time**, never re-resolved on read.
- `units.ToBase` / `units.ResolveEntered` errors surface as `httpx.ValidationError` carrying `units.UnrecognisedUnitMessage`. Never substitute a default.
- `CreateBatch` is **all-or-nothing** inside a transaction. Do not introduce a partial-success shape. A unit-resolution failure must join the existing failure path and name the ingredient, the way the unresolvable-`food_item_id` case already does via `NameForID`.
- Legacy rows (entered pair NULL) keep working unchanged.
- `apps/mobile/src/units/convert.ts` must NOT be modified — it owns body weight and water, and the metric/imperial preference must never reach food portions.
- Composing from the diary must NOT modify the original diary entries.
- Go tests table-driven with testify, run from `api/`. Local Postgres has a low connection cap — always use `-p 1`.
- Mobile tests run from `apps/mobile/` via `npx jest`; typecheck with `npx tsc --noEmit`.
- `apps/mobile/AGENTS.md` requires reading the exact versioned Expo docs at https://docs.expo.dev/versions/v57.0.0/ before writing Expo code.
- Commits: conventional, **single-line**, no signature or attribution.

---

### Task 1: Batch logging carries the entered unit

**Files:**
- Modify: `api/internal/foodlog/service.go:397-403` (BatchItem), `:419-470` (CreateBatch)
- Test: `api/internal/foodlog/service_test.go`

**Interfaces:**
- Consumes: `units.ResolveEntered`, `units.UnrecognisedUnitMessage` (already on disk in `api/internal/units`); the package-local `resolveEnteredUnit(item nutrition.FoodItem, amount float64, unit string) (float64, error)` bridge already used by `LogFood` in this same file
- Produces: `BatchItem.EnteredAmount *float64` / `BatchItem.EnteredUnit *string`, both `json:"entered_amount"` / `json:"entered_unit"`; batch-created `FoodLog` rows carrying the entered pair

- [ ] **Step 1: Write the failing test**

Add to `api/internal/foodlog/service_test.go`, adapting the fixture names to the setup already present in that file:

```go
func TestCreateBatchResolvesEnteredUnits(t *testing.T) {
	// A saved meal being logged: one item entered as a named serving, one as
	// plain grams. Both must land with server-resolved quantity_grams.
	amount := 2.0
	unit := "portion"

	got, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "snack",
		Items: []BatchItem{
			{FoodItemID: sachetItemID, EnteredAmount: &amount, EnteredUnit: &unit},
			{FoodItemID: milkItemID, QuantityGrams: 200},
		},
	})
	require.NoError(t, err)
	require.Len(t, got, 2)

	// 2 portions x 16.5g = 33g, resolved server-side, entered pair stored beside it.
	assert.InDelta(t, 33.0, got[0].QuantityGrams, 1e-9)
	require.NotNil(t, got[0].EnteredUnit)
	assert.Equal(t, "portion", *got[0].EnteredUnit)
	require.NotNil(t, got[0].EnteredAmount)
	assert.InDelta(t, 2.0, *got[0].EnteredAmount, 1e-9)

	// The gram-entered item is untouched and keeps a null pair.
	assert.InDelta(t, 200.0, got[1].QuantityGrams, 1e-9)
	assert.Nil(t, got[1].EnteredUnit)
}

func TestCreateBatchRejectsUnknownUnitAndLogsNothing(t *testing.T) {
	amount := 1.0
	unit := "bucket"

	_, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "snack",
		Items: []BatchItem{
			{FoodItemID: milkItemID, QuantityGrams: 200},
			{FoodItemID: sachetItemID, EnteredAmount: &amount, EnteredUnit: &unit},
		},
	})

	var verr httpx.ValidationError
	require.ErrorAs(t, err, &verr)
	// The message must name the ingredient, the way the unresolvable-id path
	// already does — an opaque "unrecognised unit" tells the user nothing about
	// WHICH item of their saved meal is the problem.
	assert.Contains(t, verr.Message, units.UnrecognisedUnitMessage)

	// All-or-nothing: the VALID first item must not have been logged either.
	logs, listErr := svc.ListByDay(ctx, userID, time.Now())
	require.NoError(t, listErr)
	assert.Empty(t, logs)
}
```

If `ListByDay` is named differently in this service, use whatever the file's other tests use to assert no rows were written.

- [ ] **Step 2: Run the test to verify it fails**

Run from `api/`: `go test ./internal/foodlog/ -run TestCreateBatch -count=1 -p 1 -v`
Expected: FAIL — `BatchItem` has no `EnteredAmount`/`EnteredUnit` field.

- [ ] **Step 3: Implement**

Add the two fields to `BatchItem`:

```go
type BatchItem struct {
	FoodItemID    uuid.UUID `json:"food_item_id"`
	QuantityGrams float64   `json:"quantity_grams"`
	EnteredAmount *float64  `json:"entered_amount"`
	EnteredUnit   *string   `json:"entered_unit"`
}
```

Inside `CreateBatch`'s per-item loop, resolve the pair **before** the existing `QuantityGrams <= 0` guard — the guard must run against the resolved figure, not the client's placeholder zero. The food row is already loaded a few lines below by `s.foods.GetByID`; move that lookup above the quantity guard so the resolution can use it, exactly as `LogFood` orders these steps.

```go
		// A saved meal logs each item in the unit it was saved in. The SERVER
		// resolves it, once, here — the client sends quantity_grams: 0 as a
		// placeholder when an entered pair is present, so the positive-quantity
		// guard below must run against the RESOLVED figure.
		grams := it.QuantityGrams
		if it.EnteredAmount != nil && it.EnteredUnit != nil {
			resolved, rerr := resolveEnteredUnit(item, *it.EnteredAmount, *it.EnteredUnit)
			if rerr != nil {
				// Name the ingredient. The user picked a meal, not an id — the
				// unresolvable-food path above already reasons this way.
				if name, ok := s.foods.NameForID(ctx, it.FoodItemID); ok {
					return httpx.ValidationError{Message: fmt.Sprintf("%s: %s", name, units.UnrecognisedUnitMessage)}
				}
				return httpx.ValidationError{Message: units.UnrecognisedUnitMessage}
			}
			grams = resolved
		}
		if grams <= 0 {
			return httpx.ValidationError{Message: "quantity_grams must be positive"}
		}
```

Use `grams` for the macro math and the constructed `FoodLog`, and set `EnteredAmount`/`EnteredUnit` on that `FoodLog` from the item. Everything else in the loop is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `api/`: `go test ./internal/foodlog/ -count=1 -p 1`
Expected: PASS, including every pre-existing batch test.

- [ ] **Step 5: Commit**

```bash
git add api/internal/foodlog/
git commit -m "feat(api): resolve and store entered units on batch-logged meals"
```

---

### Task 2: `logMeal` sends the entered pair

**Files:**
- Modify: `apps/mobile/src/api/useInstantLog.ts:110-116`
- Modify: `apps/mobile/src/api/hooks.ts` (the `useCreateLogBatch` input type)
- Test: `apps/mobile/src/api/__tests__/useInstantLog.test.tsx` (or the existing test file for this hook — find it before writing)

**Interfaces:**
- Consumes: Task 1's `entered_amount`/`entered_unit` on the batch payload
- Produces: `logMeal` sending `{food_item_id, quantity_grams, entered_amount, entered_unit}` per item

- [ ] **Step 1: Write the failing test**

```typescript
test("logging a saved meal sends each item's entered unit, not its grams", () => {
  const { result } = renderInstantLog();

  result.current.logMeal({
    meal_slot: "snack",
    items: [
      { food_item_id: "f1", name: "NESCAFÉ Mocha", grams: 16.5, entered_amount: 1, entered_unit: "portion" },
      { food_item_id: "f2", name: "Milk", grams: 200, entered_amount: null, entered_unit: null },
    ],
  });

  expect(batchMutate).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [
        // The server resolves the pair; grams is a placeholder it ignores.
        { food_item_id: "f1", quantity_grams: 0, entered_amount: 1, entered_unit: "portion" },
        { food_item_id: "f2", quantity_grams: 200, entered_amount: null, entered_unit: null },
      ],
    }),
    expect.anything(),
  );
});
```

Adapt `renderInstantLog`/`batchMutate` to however the existing tests for this hook mock `useCreateLogBatch`.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/api -t "entered unit"`
Expected: FAIL — items are sent with grams only.

- [ ] **Step 3: Implement**

In `useInstantLog.ts`, replace the item mapping in `logMeal`:

```typescript
      items: m.items.map((i) => ({
        food_item_id: i.food_item_id,
        // A placeholder when the pair is present: the SERVER resolves the unit
        // into grams, exactly as it does for a single log. Sending our own
        // grams here would put the conversion back on the client.
        quantity_grams: i.entered_unit ? 0 : i.grams,
        entered_amount: i.entered_amount ?? null,
        entered_unit: i.entered_unit ?? null,
      })),
```

Widen `LoggableMeal`'s item type to include the two optional fields, and add them to the batch input type in `hooks.ts`.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest src/api && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/api/
git commit -m "feat(mobile): log a saved meal in the units it was saved in"
```

---

### Task 3: Blank and compose seeds

**Files:**
- Modify: `apps/mobile/src/components/meals/SavedMealSheet.tsx:57` (Seed type), and the `useEffect` that seeds state from it
- Modify: `apps/mobile/src/components/meals/SavedMealSheetProvider.tsx`
- Test: `apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx`

**Interfaces:**
- Consumes: the existing `EditItem = {food_item_id, name, grams, enteredAmount, enteredUnit}`
- Produces:
  - `export type ComposedItem = { food_item_id: string; name: string; quantity_grams: number; entered_amount: number | null; entered_unit: string | null; base_unit?: string | null }`
  - `Seed` gains `| { mode: "blank" } | { mode: "compose"; items: ComposedItem[] }`
  - `useSavedMealEditor()` gains `openBlank: () => void` and `openCompose: (items: ComposedItem[]) => void`

- [ ] **Step 1: Write the failing test**

```typescript
test("a blank seed opens an empty sheet with save disabled", async () => {
  const { getByLabelText, queryByText } = await render(<SavedMealSheet seed={{ mode: "blank" }} onClose={() => {}} />);

  expect(getByLabelText("Meal name").props.value).toBe("");
  // Nothing to save yet — this must read as not-ready, not as an error the
  // user caused by opening the sheet.
  expect(getByLabelText("Save").props.accessibilityState.disabled).toBe(true);
  expect(queryByText("Add at least one item with grams.")).toBeNull();
});

test("a compose seed carries each row's entered unit into the sheet", async () => {
  const items = [
    { food_item_id: "f1", name: "NESCAFÉ Mocha", quantity_grams: 16.5, entered_amount: 1, entered_unit: "portion" },
    { food_item_id: "f2", name: "Milk", quantity_grams: 200, entered_amount: null, entered_unit: null },
  ];
  const { getByText, queryByText } = await render(<SavedMealSheet seed={{ mode: "compose", items }} onClose={() => {}} />);

  expect(getByText("NESCAFÉ Mocha")).toBeTruthy();
  expect(getByText("Milk")).toBeTruthy();
  // Name pre-filled from the first item so the user edits rather than types.
  expect(queryByText("Add at least one item with grams.")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/meals -t "blank seed"`
Expected: FAIL — `Seed` has no `blank` variant; TypeScript rejects it.

- [ ] **Step 3: Implement**

Add `ComposedItem` and widen `Seed` as in the Interfaces block. In the seeding `useEffect`, branch on `seed.mode`:

```typescript
    if (seed.mode === "blank") {
      setName("");
      setSlot("breakfast");
      setItems([]);
      setErr(null);
      return;
    }
    if (seed.mode === "compose") {
      setName(seed.items[0]?.name ?? "");
      setSlot("breakfast");
      setItems(
        seed.items.map((i) => ({
          food_item_id: i.food_item_id,
          name: i.name,
          grams: i.quantity_grams,
          enteredAmount: i.entered_amount,
          enteredUnit: i.entered_unit,
        })),
      );
      setErr(null);
      return;
    }
```

Gate the Save button on readiness rather than only validating on press: `const canSave = name.trim().length > 0 && items.length > 0 && items.every((it) => it.grams > 0 || (it.enteredAmount ?? 0) > 0);` and pass `disabled={pending || !canSave}`. Keep the existing `save()` validation as the backstop — do not delete it.

In the provider, add:

```typescript
  const openBlank = () => setSeed({ mode: "blank" });
  const openCompose = (items: ComposedItem[]) => setSeed({ mode: "compose", items });
```

and include both in the context value and the `Editor` type, with matching no-op defaults in `createContext`.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest src/components/meals && npx tsc --noEmit`
Expected: PASS including pre-existing SavedMealSheet tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/meals/
git commit -m "feat(mobile): add blank and compose seeds to the saved meal sheet"
```

---

### Task 4: Add ingredient via FoodPicker

**Files:**
- Modify: `apps/mobile/src/components/meals/SavedMealSheet.tsx`
- Test: `apps/mobile/src/components/meals/__tests__/SavedMealSheet.test.tsx`

**Interfaces:**
- Consumes: `FoodPicker` from `@/components/meal/FoodPicker` with props `{visible, initialQuery, onSelect, onClose}`; `defaultServingCount` and `baseQuantityFor` from `@/units/portion`; Task 3's seeds
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```typescript
test("adding an ingredient seeds it as a named serving, not raw grams", async () => {
  const { getByText, getByLabelText } = await render(<SavedMealSheet seed={{ mode: "blank" }} onClose={() => {}} />);

  await fireEvent.press(getByText("+ Add ingredient"));
  // FoodPicker is mocked in this suite to select a fixed food — a sachet whose
  // serving_grams is 16.5 with one named serving {portion, 1, 16.5}.
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));

  // Seeded as one portion, NOT as "16.5 g" — the whole point of the unit work.
  expect(getByText("1 portion (16.5 g)")).toBeTruthy();
});

test("adding an ingredient to an existing meal appends rather than replaces", async () => {
  const items = [{ food_item_id: "f2", name: "Milk", quantity_grams: 200, entered_amount: null, entered_unit: null }];
  const { getByText, getByLabelText } = await render(<SavedMealSheet seed={{ mode: "compose", items }} onClose={() => {}} />);

  await fireEvent.press(getByText("+ Add ingredient"));
  await fireEvent.press(getByLabelText("Select NESCAFÉ Mocha"));

  expect(getByText("Milk")).toBeTruthy();
  expect(getByText("NESCAFÉ Mocha")).toBeTruthy();
});
```

Mock `FoodPicker` in this suite the way the repo's other suites mock heavy children — check `apps/mobile/app/__tests__/capture.test.tsx` for the established pattern before inventing one.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest src/components/meals -t "adding an ingredient"`
Expected: FAIL — no "+ Add ingredient" element exists.

- [ ] **Step 3: Implement**

Add picker state and an append handler:

```typescript
  const [pickerOpen, setPickerOpen] = useState(false);

  // Seeded exactly as app/log.tsx seeds its own selection, so a picked sachet
  // lands as "1 portion" rather than "16.5 g". Only a QUANTITY is derived here.
  const addItem = (food: FoodItem) => {
    setPickerOpen(false);
    const servings = food.serving_units ?? [];
    const first = servings[0];
    const count = first ? defaultServingCount(food.serving_grams, first) : null;
    setItems((cur) => [
      ...cur,
      {
        food_item_id: food.id,
        name: food.name,
        grams: (count && first ? baseQuantityFor(count, first.name, servings) : null) ?? food.serving_grams,
        enteredAmount: count && first ? count : null,
        enteredUnit: count && first ? first.name : null,
      },
    ]);
  };
```

Render a pressable "+ Add ingredient" row directly below the item list (present in every mode), and the `FoodPicker` alongside the sheet's other children:

```tsx
        <Pressable accessibilityRole="button" accessibilityLabel="Add ingredient" onPress={() => setPickerOpen(true)}>
          <AppText style={{ color: colors.accent, marginTop: spacing.sm }}>+ Add ingredient</AppText>
        </Pressable>
        <FoodPicker visible={pickerOpen} initialQuery="" onSelect={addItem} onClose={() => setPickerOpen(false)} />
```

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest src/components/meals && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/components/meals/
git commit -m "feat(mobile): add ingredients to a saved meal from food search"
```

---

### Task 5: "+ New meal" on the Log screen

**Files:**
- Modify: `apps/mobile/app/log.tsx` (near the existing Saved section, around the `openCreate`/`openEdit` usage at line 94)
- Test: `apps/mobile/app/__tests__/log.test.tsx`

**Interfaces:**
- Consumes: `openBlank` from `useSavedMealEditor()` (Task 3)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```typescript
test("the log screen can start a new meal from scratch", async () => {
  const { getByLabelText } = await renderLog();

  await fireEvent.press(getByLabelText("New meal"));

  expect(openBlank).toHaveBeenCalled();
});
```

Mock `useSavedMealEditor` the way this suite already handles it (it is imported at `app/log.tsx:23`); if the suite does not mock it yet, mock the whole `@/components/meals/SavedMealSheetProvider` module exposing `openBlank`, `openCreate`, `openEdit` jest fns.

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest app/__tests__/log.test.tsx -t "new meal"`
Expected: FAIL — no element labelled "New meal".

- [ ] **Step 3: Implement**

Destructure `openBlank` alongside the existing two, and render a pressable beside the Saved section's `Overline`:

```tsx
        <Pressable accessibilityRole="button" accessibilityLabel="New meal" onPress={openBlank}>
          <AppText style={{ color: colors.accent }}>+ New meal</AppText>
        </Pressable>
```

Place it so it is visible whether or not the user has saved meals yet — a first-time user with no saved meals must still be able to create one.

- [ ] **Step 4: Run tests**

Run from `apps/mobile/`: `npx jest app/__tests__/log.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/log.tsx apps/mobile/app/__tests__/log.test.tsx
git commit -m "feat(mobile): start a new saved meal from the log screen"
```

---

### Task 6: Diary multi-select compose

**Files:**
- Modify: `apps/mobile/app/(tabs)/diary.tsx` (log rows render at :449-451)
- Test: `apps/mobile/app/__tests__/diary.test.tsx`

**Interfaces:**
- Consumes: `openCompose` and `ComposedItem` from Task 3
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

```typescript
test("long-pressing a diary row enters selection mode", async () => {
  const { getByLabelText, getByText } = await renderDiary();

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");

  expect(getByText("1 selected")).toBeTruthy();
});

test("saving a selection composes a meal from the selected rows", async () => {
  const { getByLabelText, getByText } = await renderDiary();

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  await fireEvent.press(getByLabelText("Milk"));
  await fireEvent.press(getByText("Save as meal"));

  // Entered units travel with the rows so the sheet opens on "1 portion".
  expect(openCompose).toHaveBeenCalledWith([
    expect.objectContaining({ food_item_id: "f1", entered_unit: "portion", entered_amount: 1 }),
    expect.objectContaining({ food_item_id: "f2", entered_unit: null }),
  ]);
});

test("cancelling selection leaves the diary untouched", async () => {
  const { getByLabelText, getByText, queryByText } = await renderDiary();

  await fireEvent(getByLabelText("NESCAFÉ Mocha"), "longPress");
  await fireEvent.press(getByText("Cancel"));

  expect(queryByText("1 selected")).toBeNull();
  expect(deleteLog).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `apps/mobile/`: `npx jest app/__tests__/diary.test.tsx -t "selection"`
Expected: FAIL — long-press does nothing.

- [ ] **Step 3: Implement**

Add selection state to the diary screen:

```typescript
  // Selection is scoped to the day on screen, which is also the only day this
  // screen has loaded. Composing NEVER edits the underlying logs — it
  // bookmarks a combination for future logging.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selecting = selectedIds.length > 0;

  const toggleSelected = (id: string) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
```

Give each log `MealRow` an `onLongPress={() => toggleSelected(log.id)}`, and make `onPress` toggle selection instead of navigating while `selecting` is true. Render a header bar when `selecting`:

```tsx
      {selecting ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 }}>
          <AppText>{`${selectedIds.length} selected`}</AppText>
          <View style={{ flexDirection: "row", gap: 16 }}>
            <Pressable accessibilityRole="button" onPress={() => setSelectedIds([])}>
              <AppText>Cancel</AppText>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={saveSelectionAsMeal}>
              <AppText style={{ color: colors.accent }}>Save as meal</AppText>
            </Pressable>
          </View>
        </View>
      ) : null}
```

with:

```typescript
  const saveSelectionAsMeal = () => {
    const chosen = logs.filter((l) => selectedIds.includes(l.id));
    setSelectedIds([]);
    openCompose(
      chosen.map((l) => ({
        food_item_id: l.food_item_id,
        name: l.name,
        quantity_grams: l.quantity_grams,
        entered_amount: l.entered_amount ?? null,
        entered_unit: l.entered_unit ?? null,
        base_unit: l.base_unit ?? null,
      })),
    );
  };
```

Adapt `logs`/`l.name` to the actual variable and field names used where rows render around `diary.tsx:449`.

- [ ] **Step 4: Run the full mobile suite**

Run from `apps/mobile/`: `npx jest && npx tsc --noEmit`
Expected: PASS across all suites — pre-existing diary tests must be unaffected, since a plain tap still behaves as before when not selecting.

- [ ] **Step 5: Commit**

```bash
git add "apps/mobile/app/(tabs)/diary.tsx" apps/mobile/app/__tests__/diary.test.tsx
git commit -m "feat(mobile): compose a saved meal from selected diary entries"
```

---

## Verification

After Task 6, from the repo root:

```bash
cd api && go build ./... && go vet ./... && go test ./... -count=1 -p 1
cd ../apps/mobile && npx jest && npx tsc --noEmit
```

Then, by hand on the **iPhone 17 Pro** simulator (not the Pro Max):

1. Log screen → "+ New meal" → name it, add the milk and the mocha via search → Save. Both ingredients should read in their own units, not grams.
2. Home → tap the new saved meal → the diary should show two rows reading "1 portion" and "200 ml", not gram figures.
3. Diary → long-press one row, tap a second, "Save as meal" → the sheet opens with both, units intact, and the two original diary rows are still there, unmodified.
