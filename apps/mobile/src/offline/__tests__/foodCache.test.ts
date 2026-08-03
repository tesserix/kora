import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  upsertFoods,
  getFoodById,
  getFoodByBarcode,
  searchCachedFoods,
  foodsFromPins,
  foodsFromSavedMeals,
  FOOD_CACHE_LIMIT,
} from "../foodCache";
import type { FoodItem, PinnedFood, SavedMeal } from "@/api/types";
import { UNKNOWN_PROVENANCE } from "@/api/types";

function food(id: string, name: string, barcode?: string): FoodItem {
  return {
    id, name, brand: "", provenance: "usda", serving_desc: "100 g", serving_grams: 100,
    kcal_per_100g: 100, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
    ...(barcode ? { barcode } : {}),
  } as FoodItem;
}

beforeEach(async () => { await AsyncStorage.clear(); });

test("upsert then look up by id", async () => {
  await upsertFoods([food("f1", "Greek yogurt")]);
  expect((await getFoodById("f1"))?.name).toBe("Greek yogurt");
  expect(await getFoodById("nope")).toBeNull();
});

test("look up by barcode — a repeat scan works offline", async () => {
  await upsertFoods([food("f1", "Greek yogurt", "12345")]);
  expect((await getFoodByBarcode("12345"))?.id).toBe("f1");
  expect(await getFoodByBarcode("99999")).toBeNull();
});

test("search matches on a name substring, case-insensitively", async () => {
  await upsertFoods([food("f1", "Greek yogurt"), food("f2", "Cheddar cheese")]);
  expect((await searchCachedFoods("yog")).map((f) => f.id)).toEqual(["f1"]);
  expect((await searchCachedFoods("CHEESE")).map((f) => f.id)).toEqual(["f2"]);
  expect(await searchCachedFoods("sushi")).toEqual([]);
});

test("upserting the same id updates rather than duplicating", async () => {
  await upsertFoods([food("f1", "Old name")]);
  await upsertFoods([food("f1", "New name")]);
  expect((await getFoodById("f1"))?.name).toBe("New name");
  expect(await searchCachedFoods("name")).toHaveLength(1);
});

test("the cache evicts least-recently-used entries at the cap", async () => {
  const many = Array.from({ length: FOOD_CACHE_LIMIT + 10 }, (_, i) => food(`f${i}`, `Food ${i}`));
  await upsertFoods(many);
  // The 10 oldest are gone, the newest survive, and the cap holds.
  expect(await getFoodById("f0")).toBeNull();
  expect(await getFoodById(`f${FOOD_CACHE_LIMIT + 9}`)).not.toBeNull();
  expect(await searchCachedFoods("Food")).toHaveLength(FOOD_CACHE_LIMIT);
});

// The test above upserts everything in ONE call, so every item gets a
// timestamp derived from a single `now`. That alone cannot distinguish real
// least-recently-USED eviction from mere insertion-order truncation — an
// implementation that just kept "the last N items passed to upsertFoods,
// across all calls ever" would pass it too.
//
// This test is the one that actually exercises "used": f0 is the very first
// food ever cached (chronologically oldest by insertion), but it gets
// touched again — re-upserted — after a batch of fillers land and before the
// flood that forces eviction. A real LRU must keep f0 (recently touched) and
// evict some of the fillers instead, even though those fillers were inserted
// AFTER f0 and never touched again. Date.now() is mocked so ordering across
// the four separate upsertFoods calls is deterministic rather than racing
// millisecond-resolution wall-clock time.
test("re-upserting a food refreshes its recency and protects it from eviction", async () => {
  let now = 1_000_000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  try {
    await upsertFoods([food("f0", "Food 0")]);

    now += 1000;
    const fillerCount = FOOD_CACHE_LIMIT - 1;
    const fillers = Array.from({ length: fillerCount }, (_, i) => food(`fill${i}`, `Filler ${i}`));
    await upsertFoods(fillers); // cache is now exactly at FOOD_CACHE_LIMIT (f0 + fillers), no eviction yet

    now += 1000;
    await upsertFoods([food("f0", "Food 0 again")]); // re-upsert: f0 is now the MOST recently used entry

    now += 1000;
    const flood = Array.from({ length: 10 }, (_, i) => food(`flood${i}`, `Flood ${i}`));
    await upsertFoods(flood); // pushes 10 past the cap; the 10 LEAST recently used entries must go

    // f0 was inserted first of all, but was re-touched most recently of the
    // pre-flood entries — a true LRU keeps it.
    expect((await getFoodById("f0"))?.name).toBe("Food 0 again");
    // The fillers inserted earliest in their own batch (never touched again)
    // are the least recently used survivors and must be evicted instead.
    for (let i = 0; i < 10; i++) {
      expect(await getFoodById(`fill${i}`)).toBeNull();
    }
    // The most-recently-inserted fillers survive.
    expect(await getFoodById(`fill${fillerCount - 1}`)).not.toBeNull();
    expect(await searchCachedFoods("Food")).toHaveLength(1); // only f0
  } finally {
    nowSpy.mockRestore();
  }
});

test("a corrupt stored value yields an empty cache instead of throwing", async () => {
  await AsyncStorage.setItem("kora.foodCache", "{not json");
  await expect(getFoodById("f1")).resolves.toBeNull();
});

// --- foodsFromPins / foodsFromSavedMeals: the conversion logic that used to
// live in api/hooks.ts as a duck-typed extractFoods(data: unknown). That
// version silently produced [] for every real /v1/pins response (PinnedFood
// has `food_item_id`, never `id`) and could have mis-cached a saved meal
// under its OWN id. These are now typed against the real PinnedFood/SavedMeal
// shapes and unit-tested directly, per code review.

function pin(overrides: Partial<PinnedFood> = {}): PinnedFood {
  return {
    food_item_id: "f1", name: "Greek yogurt", meal_slot: "breakfast",
    grams: 150, kcal: 150, protein_g: 15, carbs_g: 6, fat_g: 3, fiber_g: 0,
    ...overrides,
  };
}

test("foodsFromPins reverses a pin's gram-scaled totals into exact per-100g macros", () => {
  const [item] = foodsFromPins([pin()]);
  expect(item.id).toBe("f1");
  expect(item.name).toBe("Greek yogurt");
  // 150 kcal / 15 g protein / 6 g carbs / 3 g fat for a 150g serving scales
  // back to exactly 100 / 10 / 4 / 2 per 100g — this is the reverse of the
  // server's own forward scaling, not an approximation.
  expect(item.kcal_per_100g).toBeCloseTo(100);
  expect(item.protein_per_100g).toBeCloseTo(10);
  expect(item.carbs_per_100g).toBeCloseTo(4);
  expect(item.fat_per_100g).toBeCloseTo(2);
});

test("foodsFromPins never fabricates serving info or a known provenance", () => {
  const [item] = foodsFromPins([pin()]);
  // The pin's 150g serving is NOT this food's canonical serving — asserting
  // something false about it would be worse than saying nothing.
  expect(item.serving_desc).toBe("");
  expect(item.serving_grams).toBe(0);
  expect(item.brand).toBe("");
  expect(item.provenance).toBe(UNKNOWN_PROVENANCE);
  expect(item.barcode).toBeUndefined();
});

test("foodsFromPins rejects a zero-gram entry rather than dividing by zero", () => {
  expect(foodsFromPins([pin({ grams: 0 })])).toEqual([]);
});

test("foodsFromSavedMeals flattens each meal's nested items and ignores the meal's own id", () => {
  const meal: SavedMeal = {
    id: "meal1",
    name: "My lunch",
    meal_slot: "lunch",
    items: [{ food_item_id: "f2", name: "Cheddar cheese", grams: 50, kcal: 200, protein_g: 12, carbs_g: 1, fat_g: 16, fiber_g: 0 }],
    kcal: 200, protein_g: 12, carbs_g: 1, fat_g: 16, fiber_g: 0,
  };
  const items = foodsFromSavedMeals([meal]);
  expect(items.map((i) => i.id)).toEqual(["f2"]);
  expect(items[0].kcal_per_100g).toBeCloseTo(400);
});

// query.data is only ever cast (`apiFetch(...) as Promise<PinnedFood[]>`),
// never actually validated — a truthy non-array response would throw
// SYNCHRONOUSLY inside the effect that calls these, outside
// cacheFoodsQuietly's `.catch`, breaking the screen rather than just the
// cache fill.
test("foodsFromPins tolerates a truthy non-array response instead of throwing", () => {
  expect(foodsFromPins({ not: "an array" } as unknown as PinnedFood[])).toEqual([]);
});

test("foodsFromSavedMeals tolerates a truthy non-array response and a meal missing items", () => {
  expect(foodsFromSavedMeals({ not: "an array" } as unknown as SavedMeal[])).toEqual([]);
  const mealWithoutItems = { id: "meal1", name: "My lunch", meal_slot: "lunch" } as unknown as SavedMeal;
  expect(foodsFromSavedMeals([mealWithoutItems])).toEqual([]);
});

// --- Fidelity: a "summary" write (pins/saved-meals) must never blank a
// field a "full" record (a real barcode-resolved FoodItem) already knows for
// the same id. It MERGES rather than refuses: a summary can still correct
// the parts it genuinely knows (name, per-100g macros — e.g. the server
// corrected a typo, or recomputed nutrition), it just can't invent the parts
// it doesn't (barcode, real provenance, canonical serving). See
// mergeSummaryIntoFull in foodCache.ts for why this replaced an earlier
// "refuse" rule: refusing also froze `lastUsedAt`, which sank a full
// record's recency to the bottom of the LRU every time something else got
// touched.
test("a summary-fidelity upsert into an existing full-fidelity record merges instead of replacing or refusing", async () => {
  const full: FoodItem = {
    id: "f1", name: "Real food", brand: "Acme", provenance: "usda",
    serving_desc: "1 bar (40 g)", serving_grams: 40,
    kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
    barcode: "0123456789",
  };
  await upsertFoods([full], "full");

  const synthesized: FoodItem = {
    ...full, name: "Corrected name", provenance: UNKNOWN_PROVENANCE,
    serving_desc: "", serving_grams: 0,
    kcal_per_100g: 300, protein_per_100g: 22, carbs_per_100g: 28, fat_per_100g: 6,
    barcode: undefined,
  };
  await upsertFoods([synthesized], "summary");

  const merged = await getFoodById("f1");
  // Takes what the summary genuinely knows: name and per-100g macros.
  expect(merged?.name).toBe("Corrected name");
  expect(merged?.kcal_per_100g).toBe(300);
  expect(merged?.protein_per_100g).toBe(22);
  expect(merged?.carbs_per_100g).toBe(28);
  expect(merged?.fat_per_100g).toBe(6);
  // Keeps what it cannot know: barcode, real provenance, canonical serving.
  expect(merged?.barcode).toBe("0123456789");
  expect(merged?.provenance).toBe("usda");
  expect(merged?.serving_desc).toBe("1 bar (40 g)");
  expect(merged?.serving_grams).toBe(40);
  expect(merged?.brand).toBe("Acme");
});

// The bug the merge rule fixes: a "refuse" rule also refuses to touch
// lastUsedAt, so a full record that only ever gets touched by summary
// writes (e.g. the user pins a barcode-scanned food and keeps using it, but
// never re-scans it) sinks in recency every time anything ELSE is touched —
// and gets evicted first, exactly the record this system exists to protect.
test("a summary touch refreshes a full-fidelity record's recency, so it is not evicted ahead of untouched summaries", async () => {
  let now = 1_000_000;
  const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const full: FoodItem = {
      id: "f0", name: "Real food", brand: "Acme", provenance: "usda",
      serving_desc: "1 bar (40 g)", serving_grams: 40,
      kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
      barcode: "0123456789",
    };
    await upsertFoods([full], "full"); // t = 1_000_000

    now += 1000;
    const fillerCount = FOOD_CACHE_LIMIT - 1;
    const fillers = Array.from({ length: fillerCount }, (_, i) => food(`fill${i}`, `Filler ${i}`));
    await upsertFoods(fillers, "summary"); // cache is now exactly at the cap: f0 (full) + fillers

    now += 1000;
    // A summary touch of f0 — e.g. usePins refetches and f0 is still pinned.
    // Same real food, so a genuine summary would report the same macros;
    // what matters here is only that this call happened and should count.
    await upsertFoods([{ ...full, provenance: UNKNOWN_PROVENANCE, barcode: undefined }], "summary");

    now += 1000;
    const flood = Array.from({ length: 10 }, (_, i) => food(`flood${i}`, `Flood ${i}`));
    await upsertFoods(flood, "summary"); // pushes 10 past the cap

    // f0 was inserted first of all, but its recency was refreshed by the
    // summary touch — it must survive, still carrying its full-fidelity
    // fields (merge, not replace).
    const survivor = await getFoodById("f0");
    expect(survivor).not.toBeNull();
    expect(survivor?.barcode).toBe("0123456789");
    expect(survivor?.provenance).toBe("usda");
    // The fillers inserted earliest in their own batch (never touched again)
    // are the least recently used survivors and must be evicted instead.
    for (let i = 0; i < 10; i++) {
      expect(await getFoodById(`fill${i}`)).toBeNull();
    }
  } finally {
    nowSpy.mockRestore();
  }
});

test("a full-fidelity upsert DOES overwrite an existing summary-fidelity record", async () => {
  const summary: FoodItem = {
    id: "f1", name: "Pinned name", brand: "", provenance: UNKNOWN_PROVENANCE,
    serving_desc: "", serving_grams: 0,
    kcal_per_100g: 999, protein_per_100g: 1, carbs_per_100g: 1, fat_per_100g: 1,
  };
  await upsertFoods([summary], "summary");

  const full: FoodItem = {
    id: "f1", name: "Real food", brand: "Acme", provenance: "usda",
    serving_desc: "1 bar (40 g)", serving_grams: 40,
    kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
    barcode: "0123456789",
  };
  await upsertFoods([full], "full");

  expect(await getFoodById("f1")).toEqual(full);
});

// --- Pre-fidelity data: entries written before fidelity tracking existed
// (round 1) carry no `fidelity` field at all. Every pre-fix writer was the
// summary path (usePins/useSavedMeals shipped before useResolveBarcode's
// writer), so those records also carry the fabricated `provenance: "cached"`
// and `serving_desc`/`serving_grams` that a later round removed. Defaulting
// them to "full" would freeze those defects in place forever; "summary" is
// self-healing.
test("a pre-fidelity stored entry (no fidelity field) defaults to summary, so a fresh summary write replaces it outright", async () => {
  await AsyncStorage.setItem("kora.foodCache", JSON.stringify([
    {
      item: { ...food("f1", "Old cached name"), provenance: "cached", serving_desc: "150 g", serving_grams: 150 },
      lastUsedAt: 1,
      // no `fidelity` field — this is what round-1 data looks like on disk.
    },
  ]));

  const freshSummary: FoodItem = {
    id: "f1", name: "New name", brand: "", provenance: UNKNOWN_PROVENANCE,
    serving_desc: "", serving_grams: 0,
    kcal_per_100g: 80, protein_per_100g: 5, carbs_per_100g: 5, fat_per_100g: 5,
  };
  await upsertFoods([freshSummary], "summary");

  // If the stale entry had defaulted to "full", this write would have been
  // MERGED — old provenance:"cached"/serving_desc/serving_grams surviving —
  // instead of replaced outright.
  expect(await getFoodById("f1")).toEqual(freshSummary);
});

test("a stored entry with an invalid fidelity value is dropped rather than trusted", async () => {
  await AsyncStorage.setItem("kora.foodCache", JSON.stringify([
    { item: food("f1", "Corrupt entry"), lastUsedAt: 1, fidelity: "not-a-real-value" },
    { item: food("f2", "Fine entry"), lastUsedAt: 1 },
  ]));

  expect(await getFoodById("f1")).toBeNull();
  expect((await getFoodById("f2"))?.name).toBe("Fine entry");
});

// usePins and useSavedMeals resolve independently and their cache-fill effects
// can land in the same tick. upsertFoods is a read-modify-write over the whole
// cache, so unserialised the second write clobbers the first and one of the two
// screens' foods is simply absent offline.
test("two concurrent upsertFoods calls do not clobber each other", async () => {
  // No await between them: both load the same (empty) cache before either saves.
  await Promise.all([
    upsertFoods([food("f1", "Greek yogurt")]),
    upsertFoods([food("f2", "Cheddar cheese")]),
  ]);

  expect((await getFoodById("f1"))?.name).toBe("Greek yogurt");
  expect((await getFoodById("f2"))?.name).toBe("Cheddar cheese");
});
