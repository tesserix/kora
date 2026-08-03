import AsyncStorage from "@react-native-async-storage/async-storage";
import { upsertFoods, getFoodById, getFoodByBarcode, searchCachedFoods, FOOD_CACHE_LIMIT } from "../foodCache";
import type { FoodItem } from "@/api/types";

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
