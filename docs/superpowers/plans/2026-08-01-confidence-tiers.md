# Per-item Confidence Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a confidence tier on every resolved candidate so a weak item can no longer ride along on a strong one, and let the user resolve the weak item in place instead of blocking the whole meal.

**Architecture:** The per-item tier is already computed in `resolveGuesses` and discarded; we keep it on `ResolvedCandidate` and stamp the other two construction paths. The mobile card renders `follow_up` rows as uncertain — no kcal, excluded from the total and the log batch — and tapping one opens the existing `FoodPicker` to promote it.

**Tech Stack:** Go 1.26 (`api/internal/ai`, `api/internal/nutrition`), React Native / Expo 57 + TypeScript (`apps/mobile`), Jest + @testing-library/react-native, testify.

## Global Constraints

- **The client never computes nutrition.** Every number in `DetectedCard` is verbatim from the server. The only sanctioned client math is summing kcal the server already supplied.
- **kcal comes only from the food-index row**, never from the LLM (`resolver.go` "INVARIANT GUARD").
- Tier thresholds stay hardcoded Go consts (`tierAutoFloor` 0.90, `tierConfirmFloor` 0.70). Do not add config or env.
- `Resolution.Tier` (the aggregate) keeps its current max-rank behaviour. It is not a bug to fix in this plan.
- Commit messages: conventional prefix, **single line**, no signatures, no trailers.
- Go tests need a live Postgres: `TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable` (Docker `kora-pg-test`, image `pgvector/pgvector:pg15`).
- Run all test commands in the **foreground**. Do not background them.

---

### Task 1: Per-item tier on the guesses path

**Files:**
- Modify: `api/internal/ai/types.go` (`ResolvedCandidate`)
- Modify: `api/internal/ai/resolver.go:361-378` (`resolveGuesses`)
- Test: `api/internal/ai/resolver_test.go`

**Interfaces:**
- Consumes: `TierFor(identifyConf, matchScore float64) Tier`, `Tier` constants `TierAuto`/`TierConfirm`/`TierFollowUp` — all already exist in `types.go`.
- Produces: `ResolvedCandidate.Tier` of type `Tier`, JSON key `tier`. Tasks 2–6 depend on this field name.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/ai/resolver_test.go`:

```go
// A meal whose two items resolve at different confidences must stamp each
// candidate with its OWN tier. Before per-item tiers, the resolution reported
// only the best item's tier (tierRank keeps the MAX), so the weak item was
// indistinguishable from the strong one.
func TestResolveText_PerItemTiers_WeakItemKeepsItsOwnTier(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	strong := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled chicken breast", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "grilled chicken breast", strong.ID)
	weak := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "White rice, cooked", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "white rice cooked", weak.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95},
			{Food: "white rice cooked", PortionEstimate: "150 g", Confidence: 0.40},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "chicken and rice")

	require.NoError(t, err)
	require.Len(t, res.Candidates, 2)
	require.Equal(t, TierAuto, res.Candidates[0].Tier)
	require.Equal(t, TierFollowUp, res.Candidates[1].Tier)
	// The aggregate deliberately still reports the BEST item's tier — it
	// answers "is anything here loggable?", not "is everything certain?".
	require.Equal(t, TierAuto, res.Tier)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./internal/ai/ -run TestResolveText_PerItemTiers -v`

Expected: FAIL — `res.Candidates[0].Tier` undefined (`ResolvedCandidate has no field or method Tier`).

- [ ] **Step 3: Add the field**

In `api/internal/ai/types.go`, add `Tier` to `ResolvedCandidate`:

```go
// ResolvedCandidate is a resolved food with nutrition taken ONLY from the
// FoodItem row (never from the LLM).
type ResolvedCandidate struct {
	Item         nutrition.FoodItem `json:"item"`
	PortionGrams float64            `json:"portion_grams"`
	Kcal         float64            `json:"kcal"`
	MatchScore   float64            `json:"match_score"`
	MatchTier    string             `json:"match_tier"`
	// Tier is this item's OWN confidence, not the resolution's. Resolution.Tier
	// keeps the max across items (it answers "is anything loggable?"), so
	// without a per-item tier a weak item is invisible beside a strong one.
	Tier Tier `json:"tier"`
}
```

- [ ] **Step 4: Stamp it in resolveGuesses**

In `api/internal/ai/resolver.go`, the tier is already computed below the append. Move the computation above the append and set the field. Replace lines 361-378:

```go
		tier := TierFor(guess.Confidence, top.MatchScore)

		candidates = append(candidates, ResolvedCandidate{
			Item:         top.Item,
			PortionGrams: grams,
			Kcal:         kcal,
			MatchScore:   top.MatchScore,
			MatchTier:    top.MatchTier,
			Tier:         tier,
		})

		if rank := tierRank(tier); rank > bestRank {
			bestRank = rank
			bestTier = tier
			provenance = top.Item.Provenance
		}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./internal/ai/ -run TestResolveText_PerItemTiers -v`

Expected: PASS.

- [ ] **Step 6: Run the whole ai package**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./internal/ai/`

Expected: `ok`. Nothing else asserts on `ResolvedCandidate` literals, so no existing test should break.

- [ ] **Step 7: Commit**

```bash
git add api/internal/ai/types.go api/internal/ai/resolver.go api/internal/ai/resolver_test.go
git commit -m "feat(api): carry a per-item confidence tier on resolved candidates"
```

---

### Task 2: Stamp the barcode and estimate paths

**Files:**
- Modify: `api/internal/ai/resolver.go:148-156` (barcode), `api/internal/ai/resolver.go:432-450` (estimate)
- Test: `api/internal/ai/resolver_test.go`

**Interfaces:**
- Consumes: `ResolvedCandidate.Tier` from Task 1.
- Produces: nothing new. After this task every construction site sets `Tier`, so a zero-value `""` tier can only mean an older server.

- [ ] **Step 1: Write the failing test**

Add to `api/internal/ai/resolver_test.go`:

```go
// The decompose/estimate fallback builds candidates by a different path than
// resolveGuesses. Its items are inherently uncertain — the whole Resolution is
// TierConfirm and IsEstimate — so each candidate must say so rather than
// arriving with an empty tier the client has to guess about.
func TestResolveText_EstimatePath_StampsConfirmTierOnEveryCandidate(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "White rice, cooked", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "white rice cooked", item.ID)

	provider := &stubProvider{
		guesses:    []Guess{{Food: "nasi campur", PortionEstimate: "300 g", Confidence: 0.20}},
		ingredients: []Guess{{Food: "white rice cooked", PortionEstimate: "150 g", Confidence: 0.6}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "nasi campur")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.NotEmpty(t, res.Candidates)
	for i, c := range res.Candidates {
		require.Equal(t, TierConfirm, c.Tier, "candidate %d", i)
	}
}
```

Note: `stubProvider`'s decompose field may be named differently — read the struct at the top of `resolver_test.go` and use its actual field name for the decompose/ingredients response. Mirror `TestResolveText_UnknownDish_DecomposesToEstimate` (`resolver_test.go:407`), which already drives this path.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./internal/ai/ -run TestResolveText_EstimatePath -v`

Expected: FAIL — got `""`, want `"confirm"`.

- [ ] **Step 3: Stamp both paths**

In the estimate builder (`resolver.go`, the append near line 432):

```go
		candidates = append(candidates, ResolvedCandidate{
			Item:         top.Item,
			PortionGrams: grams,
			Kcal:         kcal,
			MatchScore:   top.MatchScore,
			MatchTier:    top.MatchTier,
			// The whole estimate resolution is TierConfirm; each item inherits
			// it, since none was individually identified with confidence.
			Tier: TierConfirm,
		})
```

In the barcode builder (`resolver.go`, the append near line 148):

```go
		candidates := []ResolvedCandidate{{
			Item:         item,
			PortionGrams: grams,
			Kcal:         kcal,
			MatchScore:   1,
			MatchTier:    nutrition.MatchAlias, // exact barcode == exact match
			Tier:         TierAuto,
		}}
```

Keep the surrounding lines exactly as they are; only add the `Tier` line. Read each site before editing — the field lists differ slightly between the two.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./internal/ai/ -run TestResolveText_EstimatePath -v`

Expected: PASS.

- [ ] **Step 5: Run the full Go suite**

Run: `cd api && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test ./...`

Expected: all packages `ok`.

- [ ] **Step 6: Commit**

```bash
git add api/internal/ai/resolver.go api/internal/ai/resolver_test.go
git commit -m "feat(api): stamp per-item tiers on the barcode and estimate paths"
```

---

### Task 3: Mobile type + totals exclude uncertain items

**Files:**
- Modify: `apps/mobile/src/api/types.ts` (`ResolvedCandidate`)
- Create: `apps/mobile/src/lib/candidateTier.ts`
- Modify: `apps/mobile/src/lib/resolutionKcal.ts`
- Test: `apps/mobile/src/lib/__tests__/candidateTier.test.ts`, `apps/mobile/src/lib/__tests__/resolutionKcal.test.ts`

**Interfaces:**
- Consumes: JSON key `tier` from Tasks 1–2.
- Produces:
  - `isLoggable(candidate: ResolvedCandidate): boolean` — `false` only for `tier === "follow_up"`.
  - `loggableCandidates(resolution: Resolution): ResolvedCandidate[]`
  - `contributesKcal(candidate: ResolvedCandidate): boolean` — loggable **and** has a server-computed kcal.
  - All three exported from `@/lib/candidateTier`. Tasks 4–6 import these; do not re-derive the rules inline anywhere.
  - `ResolvedCandidate.kcal_unknown?: boolean` — client-set only, never sent by the server. Task 6 sets it on a promoted row; Task 4 renders `—` for it.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/lib/__tests__/candidateTier.test.ts`:

```ts
import { isLoggable, loggableCandidates } from "../candidateTier";
import type { Resolution, ResolvedCandidate } from "@/api/types";

function candidate(tier: ResolvedCandidate["tier"], kcal = 100): ResolvedCandidate {
  return {
    item: { id: "f1", name: "Thing" } as ResolvedCandidate["item"],
    portion_grams: 100,
    kcal,
    match_score: 0.8,
    match_tier: "full_text",
    tier,
  };
}

test("only follow_up items are excluded from logging", () => {
  expect(isLoggable(candidate("auto"))).toBe(true);
  expect(isLoggable(candidate("confirm"))).toBe(true);
  expect(isLoggable(candidate("follow_up"))).toBe(false);
});

// An older server sends no tier at all. Treat that as loggable: silently
// dropping food is worse than showing it, and this is the pre-upgrade shape.
test("a candidate with no tier stays loggable", () => {
  const legacy = { ...candidate("auto") } as Partial<ResolvedCandidate>;
  delete legacy.tier;
  expect(isLoggable(legacy as ResolvedCandidate)).toBe(true);
});

test("loggableCandidates drops the uncertain ones", () => {
  const resolution = {
    candidates: [candidate("auto"), candidate("follow_up"), candidate("confirm")],
  } as Resolution;
  expect(loggableCandidates(resolution)).toHaveLength(2);
});

// A row the user resolved by hand is loggable but has no server-computed kcal.
// It must not contribute to a total, and must never render a number — showing
// "0 kcal" would be the client inventing nutrition.
test("a hand-picked row is loggable but contributes no kcal", () => {
  const picked = { ...candidate("confirm", 0), kcal_unknown: true };
  expect(isLoggable(picked)).toBe(true);
  expect(contributesKcal(picked)).toBe(false);
  expect(contributesKcal(candidate("confirm", 120))).toBe(true);
  expect(contributesKcal(candidate("follow_up", 120))).toBe(false);
});
```

Add `contributesKcal` to the import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest --ci --forceExit src/lib/__tests__/candidateTier.test.ts`

Expected: FAIL — `Cannot find module '../candidateTier'`.

- [ ] **Step 3: Add the type field and the module**

In `apps/mobile/src/api/types.ts`, add `tier` to `ResolvedCandidate`:

```ts
export interface ResolvedCandidate {
  item: FoodItem;
  portion_grams: number;
  kcal: number;
  match_score: number;
  match_tier: string;
  /** This item's own confidence. Optional: an older server omits it. */
  tier?: ResolveTier;
  /**
   * Client-set only, never sent by the server. Marks a row the user resolved
   * by hand after capture: it is loggable, but the server has computed no kcal
   * for it yet, so the card must render "—" rather than invent a figure.
   */
  kcal_unknown?: boolean;
}
```

Create `apps/mobile/src/lib/candidateTier.ts`:

```ts
import type { Resolution, ResolvedCandidate } from "@/api/types";

// A candidate is loggable unless the server called it out as needing a
// follow-up. An absent tier means an older server, and absent data is not
// evidence of doubt — treat it as loggable rather than silently dropping food.
export function isLoggable(candidate: ResolvedCandidate): boolean {
  return candidate.tier !== "follow_up";
}

export function loggableCandidates(resolution: Resolution): ResolvedCandidate[] {
  return resolution.candidates.filter(isLoggable);
}

// Loggable is not the same as countable. A row the user picked by hand will be
// logged, but carries no server-computed kcal — it contributes nothing to the
// total and renders "—", because deriving its kcal here would put nutrition
// math in the client.
export function contributesKcal(candidate: ResolvedCandidate): boolean {
  return isLoggable(candidate) && !candidate.kcal_unknown;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest --ci --forceExit src/lib/__tests__/candidateTier.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing totals test**

Append to `apps/mobile/src/lib/__tests__/resolutionKcal.test.ts` (create the file with the same imports as the tests above if it does not exist):

```ts
test("the header total ignores items that will not be logged", () => {
  const resolution = {
    is_estimate: false,
    candidates: [
      { item: { id: "a" }, portion_grams: 100, kcal: 200, match_score: 0.95, match_tier: "alias", tier: "auto" },
      { item: { id: "b" }, portion_grams: 100, kcal: 500, match_score: 0.3, match_tier: "embedding", tier: "follow_up" },
    ],
  } as unknown as Resolution;
  expect(kcalTotalLabel(resolution)).toBe("200 kcal");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/mobile && npx jest --ci --forceExit src/lib/__tests__/resolutionKcal.test.ts`

Expected: FAIL — received `"700 kcal"`.

- [ ] **Step 7: Make the total exclude uncertain items**

In `apps/mobile/src/lib/resolutionKcal.ts`:

```ts
import type { Resolution } from "@/api/types";
import { contributesKcal } from "@/lib/candidateTier";

// The Detected total, verbatim from the server's per-candidate kcal — the only
// sanctioned client math is summing the provided kcal (never a nutrition
// recompute). Items the card will not log are excluded, so the number always
// describes exactly what "Add to diary" is about to write.
export function kcalTotalLabel(resolution: Resolution): string {
  if (resolution.is_estimate) {
    return `${Math.round(resolution.kcal_low ?? 0)}–${Math.round(resolution.kcal_high ?? 0)} kcal`;
  }
  const sum = resolution.candidates
    .filter(contributesKcal)
    .reduce((total, candidate) => total + candidate.kcal, 0);
  return `${Math.round(sum)} kcal`;
}
```

The `is_estimate` branch is deliberately untouched: those ranges come from the server whole and are not per-item sums.

- [ ] **Step 8: Run it to verify it passes**

Run: `cd apps/mobile && npx jest --ci --forceExit src/lib/__tests__/resolutionKcal.test.ts`

Expected: PASS.

- [ ] **Step 9: Mutation-check your own test**

Temporarily change `.filter(contributesKcal)` back to nothing (sum all candidates) and re-run Step 8. It MUST fail. Restore the correct line. A test that passes either way is not evidence.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src/api/types.ts apps/mobile/src/lib/candidateTier.ts apps/mobile/src/lib/resolutionKcal.ts apps/mobile/src/lib/__tests__/candidateTier.test.ts apps/mobile/src/lib/__tests__/resolutionKcal.test.ts
git commit -m "feat(mobile): exclude uncertain items from the detected total"
```

---

### Task 4: Render uncertain rows in DetectedCard

**Files:**
- Modify: `apps/mobile/src/components/capture/DetectedCard.tsx`
- Test: `apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx`

**Interfaces:**
- Consumes: `isLoggable`, `loggableCandidates` from Task 3.
- Produces: `DetectedCard` gains one optional prop — `onResolveUncertain?: (index: number) => void`. Task 6 supplies it. When absent the row still renders as uncertain but is not pressable.

- [ ] **Step 1: Write the failing test**

`apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx` already exists and has a `makeResolution(overrides)` helper returning two candidates ("Grilled chicken breast" 231.2 kcal, "Steamed broccoli" 30.6 kcal). Reuse it. Add:

```tsx
// The second candidate is demoted to follow_up; the first stays confident.
function makeMixedResolution(): Resolution {
  const base = makeResolution();
  return {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" },
      { ...base.candidates[1], tier: "follow_up" },
    ],
  };
}

function renderCard(resolution: Resolution, onResolveUncertain?: (index: number) => void) {
  return render(
    <DetectedCard
      resolution={resolution}
      mealSlot="snack"
      onChangeMealSlot={() => {}}
      onAdd={() => {}}
      adding={false}
      onResolveUncertain={onResolveUncertain}
    />,
  );
}

test("an uncertain item shows a prompt instead of a kcal figure", () => {
  const { getByText, queryByText } = renderCard(makeMixedResolution());
  expect(getByText("Not sure which — tap to confirm")).toBeTruthy();
  expect(queryByText("31 kcal")).toBeNull();
  expect(getByText("231 kcal")).toBeTruthy();
});

test("the header total counts only what will be logged", () => {
  const { getByText } = renderCard(makeMixedResolution());
  // 231.2 alone, not 231.2 + 30.6.
  expect(getByText("231 kcal")).toBeTruthy();
});

test("the CTA counts loggable items, not detected ones", () => {
  const { getByText } = renderCard(makeMixedResolution());
  expect(getByText("Detected · 2 items")).toBeTruthy();
  expect(getByText("Add 1 item to diary")).toBeTruthy();
});

test("the CTA is disabled when every item is uncertain", () => {
  const base = makeResolution();
  const allUncertain = {
    ...base,
    candidates: base.candidates.map((c) => ({ ...c, tier: "follow_up" as const })),
  };
  const { getByLabelText } = renderCard(allUncertain);
  expect(getByLabelText("Add to diary").props.accessibilityState.disabled).toBe(true);
});

test("tapping an uncertain row asks to resolve it by index", () => {
  const onResolveUncertain = jest.fn();
  const { getByLabelText } = renderCard(makeMixedResolution(), onResolveUncertain);
  fireEvent.press(getByLabelText("Confirm Steamed broccoli"));
  expect(onResolveUncertain).toHaveBeenCalledWith(1);
});

test("a hand-picked row is loggable but still shows no kcal", () => {
  const base = makeResolution();
  const promoted = {
    ...base,
    candidates: [
      { ...base.candidates[0], tier: "auto" as const },
      { ...base.candidates[1], tier: "confirm" as const, kcal_unknown: true },
    ],
  };
  const { getByText, queryByText } = renderCard(promoted);
  expect(getByText("Add 2 items to diary")).toBeTruthy();
  expect(queryByText("0 kcal")).toBeNull();
  expect(getByText("231 kcal")).toBeTruthy();
});
```

The last test is the one that matters most: `kcal_unknown` must render `—`, never `0 kcal`. A promoted row is `confirm`, so a naive "only uncertain rows hide kcal" implementation passes every other test here and fails this one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest --ci --forceExit src/components/capture/__tests__/DetectedCard.test.tsx`

Expected: FAIL — "Not sure which — tap to confirm" not found.

- [ ] **Step 3: Render the uncertain row**

In `DetectedCard.tsx`, extend `CandidateRow` to take the uncertain state and a press handler:

```tsx
function CandidateRow({
  candidate,
  isLast,
  onResolve,
}: {
  candidate: ResolvedCandidate;
  isLast: boolean;
  onResolve?: () => void;
}) {
  const { icon } = foodVisual(candidate.item.name);
  const { gradients } = useTheme();
  const uncertain = !isLoggable(candidate);
  // Two different reasons to withhold a number: the item is unresolved, or the
  // user picked it and no server kcal exists yet. Both render "—". Rendering
  // candidate.kcal for a hand-picked row would print a fabricated 0.
  const showsKcal = contributesKcal(candidate);

  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 11, paddingVertical: 8, borderBottomWidth: isLast ? 0 : 1, borderBottomColor: captureColors.cardDivider }}>
      <View style={{ width: 38, height: 38, borderRadius: 8, alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: captureColors.tileBg }}>
        <Icon name={uncertain ? "help-circle" : icon} size={18} color={captureColors.tileFg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ color: captureColors.onSurface, fontSize: 14, fontWeight: "600" }}>
          {candidate.item.name}
        </AppText>
        <AppText style={{ color: captureColors.onSurfaceFaint, fontSize: 11 }}>
          {uncertain
            ? "Not sure which — tap to confirm"
            : `${Math.round(candidate.portion_grams)}g`}
        </AppText>
        {uncertain ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
            <MacroChip label="P" per100g={candidate.item.protein_per_100g} tint={gradients.green[0]} />
            <MacroChip label="C" per100g={candidate.item.carbs_per_100g} tint={gradients.amber[0]} />
            <MacroChip label="F" per100g={candidate.item.fat_per_100g} tint={gradients.blue[0]} />
          </View>
        )}
      </View>
      <AppText style={{ flexShrink: 0, color: showsKcal ? captureColors.onSurface : captureColors.onSurfaceFaint, fontSize: 13, fontWeight: "700" }}>
        {showsKcal ? `${Math.round(candidate.kcal)} kcal` : "—"}
      </AppText>
    </View>
  );

  if (!uncertain || !onResolve) return body;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Confirm ${candidate.item.name}`} onPress={onResolve}>
      {body}
    </Pressable>
  );
}
```

Note the confident row loses its `% match` suffix — that raw percentage is the false precision #21 exists to remove. The portion stays.

- [ ] **Step 4: Wire the count and the CTA**

In `DetectedCard`, add the prop and derive the counts:

```tsx
interface Props {
  resolution: Resolution;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
  onResolveUncertain?: (index: number) => void;
}
```

Inside the component, before the return:

```tsx
  const loggable = loggableCandidates(resolution);
  const nothingToLog = loggable.length === 0;
  const ctaLabel = `Add ${loggable.length} item${loggable.length === 1 ? "" : "s"} to diary`;
```

Pass `onResolve` down in the map:

```tsx
      {resolution.candidates.map((candidate, i) => (
        <CandidateRow
          key={`${candidate.item.id}-${i}`}
          candidate={candidate}
          isLast={i === resolution.candidates.length - 1}
          onResolve={onResolveUncertain ? () => onResolveUncertain(i) : undefined}
        />
      ))}
```

On the CTA `Pressable`, replace `disabled={adding}` with `disabled={adding || nothingToLog}`, mirror it in `accessibilityState={{ disabled: adding || nothingToLog }}`, and render `ctaLabel` as the button text in place of the current static label.

Also update `kcalTotalValue` to `resolution.candidates.filter(contributesKcal)` in its non-estimate branch so the ring agrees with the text, and leave `Detected · N items` counting `resolution.candidates.length` — the header states what was seen, the CTA states what will be logged.

Import at the top of `DetectedCard.tsx`: `import { contributesKcal, isLoggable, loggableCandidates } from "@/lib/candidateTier";`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/mobile && npx jest --ci --forceExit src/components/capture/__tests__/DetectedCard.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/capture/DetectedCard.tsx apps/mobile/src/components/capture/__tests__/DetectedCard.test.tsx
git commit -m "feat(mobile): surface uncertain items in the detected card"
```

---

### Task 5: Keep uncertain items out of the log batch

**Files:**
- Modify: `apps/mobile/app/capture.tsx:871-900` (`handleAddToDiary`)
- Test: `apps/mobile/app/__tests__/capture.test.tsx`

**Interfaces:**
- Consumes: `isLoggable` from Task 3.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

`apps/mobile/app/__tests__/capture.test.tsx` already has `makeCandidate(id, name, {grams, kcal})`, `makeMultiCandidateResolution()`, and an async `resolveWithMultiCandidates(rendered)` helper (around line 721) that drives a text resolve and returns the rendered tree. Read those before writing, and reuse them. Add:

```tsx
test("adding to diary skips items the card marked uncertain", async () => {
  const resolution: Resolution = {
    ...makeMultiCandidateResolution(),
    candidates: [
      { ...makeCandidate("a", "Grilled chicken breast", { grams: 170, kcal: 281 }), tier: "auto" },
      { ...makeCandidate("b", "Rice dish", { grams: 200, kcal: 260 }), tier: "follow_up" },
    ],
  };
  mockResolveTextMutate.mockImplementation((_input, opts) => opts.onSuccess(resolution));
  mockCreateLogMutateAsync.mockResolvedValue({ id: "log1" });

  const rendered = render(<Capture />);
  await resolveWithMultiCandidates(rendered);

  fireEvent.press(rendered.getByLabelText("Add to diary"));
  await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(1));
  expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ food_item_id: "a" }));
});
```

If `resolveWithMultiCandidates` hard-codes its own resolution, either parameterise it or inline the two lines it performs (type a phrase, press send) rather than duplicating a second helper. Match the surrounding tests' exact mechanism for driving `mockResolveTextMutate` — the shape shown above is the common one in this file, but confirm it against a neighbouring test before relying on it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest --ci --forceExit app/__tests__/capture.test.tsx`

Expected: FAIL — called twice.

- [ ] **Step 3: Filter the batch**

In `handleAddToDiary`, add `isLoggable` to the existing filter chain:

```tsx
    const pending = resolution.candidates
      .map((candidate, index) => ({ candidate, key: candidateKey(candidate, index) }))
      .filter(({ candidate }) => isLoggable(candidate))
      .filter(({ key }) => !loggedCandidateKeys.has(key));
```

Import it at the top: `import { isLoggable } from "@/lib/candidateTier";`

Also relax the guard on the first line of the function so an all-uncertain resolution cannot start a spinner for an empty batch:

```tsx
    if (!resolution || resolution.candidates.filter(isLoggable).length === 0) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest --ci --forceExit app/__tests__/capture.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__/capture.test.tsx
git commit -m "feat(mobile): keep uncertain items out of the log batch"
```

---

### Task 6: Resolve an uncertain item with FoodPicker

**Files:**
- Modify: `apps/mobile/app/capture.tsx`
- Test: `apps/mobile/app/__tests__/capture.test.tsx`

**Interfaces:**
- Consumes: `DetectedCard`'s `onResolveUncertain?: (index: number) => void` from Task 4; `FoodPicker` from `@/components/meal/FoodPicker` with props `{ visible, initialQuery, onSelect(item: FoodItem), onClose }`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Add to `apps/mobile/app/__tests__/capture.test.tsx`:

`FoodPicker` calls `useFoodSearch`, which `capture.test.tsx` does not currently mock. Add it to the existing `jest.mock("@/api/hooks", ...)` factory in that file:

```tsx
  useFoodSearch: () => ({
    data: [{ item: { id: "picked", name: "White rice, cooked", kcal_per_100g: 130 }, match_score: 0.9, match_tier: "full_text" }],
    isLoading: false,
  }),
```

Confirm the shape against `FoodPicker.tsx`'s own usage before relying on it — it reads `search.data` and renders each entry's food name and `kcal_per_100g`.

```tsx
test("picking a food for an uncertain item makes it loggable without inventing a kcal", async () => {
  const resolution: Resolution = {
    ...makeMultiCandidateResolution(),
    candidates: [
      { ...makeCandidate("a", "Grilled chicken breast", { grams: 170, kcal: 281 }), tier: "auto" },
      { ...makeCandidate("b", "Rice dish", { grams: 200, kcal: 260 }), tier: "follow_up" },
    ],
  };
  mockResolveTextMutate.mockImplementation((_input, opts) => opts.onSuccess(resolution));
  mockCreateLogMutateAsync.mockResolvedValue({ id: "log1" });

  const rendered = render(<Capture />);
  await resolveWithMultiCandidates(rendered);

  // The uncertain row is pressable and opens the picker.
  fireEvent.press(rendered.getByLabelText("Confirm Rice dish"));
  fireEvent.press(await rendered.findByText("White rice, cooked"));

  // Promoted: counted by the CTA, but still no fabricated kcal.
  await waitFor(() => expect(rendered.getByText("Add 2 items to diary")).toBeTruthy());
  expect(rendered.queryByText("0 kcal")).toBeNull();
  expect(rendered.queryByText("260 kcal")).toBeNull();

  fireEvent.press(rendered.getByLabelText("Add to diary"));
  await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(2));
  expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ food_item_id: "picked" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest --ci --forceExit app/__tests__/capture.test.tsx`

Expected: FAIL — no picker opens; the uncertain row is not pressable.

- [ ] **Step 3: Hold the promotions in state**

In `capture.tsx`, near the other capture state:

```tsx
  // Index -> the food the user picked for an uncertain candidate. Local only:
  // nothing is written until the CTA is pressed.
  const [promoted, setPromoted] = useState<Record<number, FoodItem>>({});
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
```

Reset both wherever a new resolution replaces the old one (the same place `loggedCandidateKeys` is reset) so a promotion cannot leak onto the next capture.

- [ ] **Step 4: Apply promotions to the resolution passed down**

```tsx
  // A promoted row carries the picked food and becomes loggable, but keeps NO
  // kcal: kcal is only ever server-computed (resolver.go), and this client is
  // forbidden from deriving nutrition. The true figure lands in the diary the
  // moment it is logged.
  const effectiveResolution = useMemo(() => {
    if (!resolution || Object.keys(promoted).length === 0) return resolution;
    return {
      ...resolution,
      candidates: resolution.candidates.map((candidate, i) =>
        promoted[i]
          ? { ...candidate, item: promoted[i], kcal: 0, tier: "confirm" as const, kcal_unknown: true }
          : candidate,
      ),
    };
  }, [resolution, promoted]);
```

Pass `effectiveResolution` to `DetectedCard` in place of `resolution`, and use it in `handleAddToDiary` so the picked food is what gets logged. `kcal: 0` is never displayed — `kcal_unknown` makes `contributesKcal` false, so the row renders `—` and the total skips it entirely. The `0` exists only so the field stays a number.

- [ ] **Step 5: Wire the card and the picker**

On `DetectedCard`, add `onResolveUncertain={(i) => setPickerIndex(i)}`.

Render the picker alongside it:

```tsx
      <FoodPicker
        visible={pickerIndex !== null}
        initialQuery={pickerIndex !== null ? (resolution?.candidates[pickerIndex]?.item.name ?? "") : ""}
        onSelect={(item) => {
          if (pickerIndex !== null) setPromoted((prev) => ({ ...prev, [pickerIndex]: item }));
          setPickerIndex(null);
        }}
        onClose={() => setPickerIndex(null)}
      />
```

Import `FoodPicker` from `@/components/meal/FoodPicker` and `FoodItem` from `@/api/types`.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/mobile && npx jest --ci --forceExit app/__tests__/capture.test.tsx`

Expected: PASS.

- [ ] **Step 7: Run the full mobile suite and typecheck**

Run, in the foreground, one after the other:
```bash
cd apps/mobile && npm test
cd apps/mobile && npx tsc --noEmit
```
Expected: all suites pass (baseline is 547 tests before this plan), `tsc` silent.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/capture.tsx apps/mobile/app/__tests__/capture.test.tsx
git commit -m "feat(mobile): let the user resolve an uncertain item before logging"
```

---

### Task 7: Verify in the running app

Tests are necessary and not sufficient. Every high-value defect in this repo across the last four sessions was found by running the app: a 401 dead-end, an Undo button rendering beneath its own sheet, an empty food index, and an onboarding bounce that trapped every new user while 543 tests passed.

**Files:** none — this task changes no code.

- [ ] **Step 1: Point Metro at prod and reload**

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --port 8082 --dev-client --clear
xcrun simctl openurl <UDID> "mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"
```

Port 8081 belongs to another project — always 8082. Confirm Metro's startup line does **not** list `EXPO_PUBLIC_API_URL` among the vars loaded from `.env`; that absence proves the shell value won.

- [ ] **Step 2: Produce a sub-0.70 item**

Capture a phrase that will not match the 85-item prod index cleanly — e.g. a regional dish name. Confirm the card shows the uncertain row with "Not sure which — tap to confirm" and `—` for kcal.

- [ ] **Step 3: Check the arithmetic**

Confirm the header total equals the sum of the confident rows only, and the CTA reads the loggable count, not the detected count.

- [ ] **Step 4: Resolve it**

Tap the uncertain row, pick a food, confirm the row becomes loggable and the CTA count increments. Log it, then check the diary shows a real server-computed kcal for the picked food.

- [ ] **Step 5: Screenshot the before/after and report**

Screenshot with `xcrun simctl io <UDID> screenshot`, downscale with `sips -Z 900`. Dismiss any LogBox toast before tapping anything near the footer — it renders over the primary button.
