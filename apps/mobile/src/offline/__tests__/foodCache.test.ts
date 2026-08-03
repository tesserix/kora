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

// --- Fidelity: a "summary" write (pins/saved-meals) must never clobber a
// "full" record (a real barcode-resolved FoodItem) already cached for the
// same id. Without this, a barcode scan's real barcode/provenance/serving
// would be silently overwritten the next time usePins/useSavedMeals refetch.
test("a summary-fidelity upsert never downgrades an existing full-fidelity record", async () => {
  const full: FoodItem = {
    id: "f1", name: "Real food", brand: "Acme", provenance: "usda",
    serving_desc: "1 bar (40 g)", serving_grams: 40,
    kcal_per_100g: 250, protein_per_100g: 20, carbs_per_100g: 30, fat_per_100g: 5,
    barcode: "0123456789",
  };
  await upsertFoods([full], "full");

  const synthesized: FoodItem = {
    ...full, name: "Pinned name", provenance: UNKNOWN_PROVENANCE,
    serving_desc: "", serving_grams: 0, kcal_per_100g: 999, barcode: undefined,
  };
  await upsertFoods([synthesized], "summary");

  expect(await getFoodById("f1")).toEqual(full);
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
