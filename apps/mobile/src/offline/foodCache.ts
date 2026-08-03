import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodItem, PinnedFood, SavedMeal } from "@/api/types";
import { UNKNOWN_PROVENANCE } from "@/api/types";

const STORAGE_KEY = "kora.foodCache";

// A person's food vocabulary is small and highly repetitive, so a few hundred
// entries covers the overwhelming majority of repeat logging at trivial cost
// (~100KB). This is deliberately NOT a mirror of the 7,848-row server index:
// a food the device has never seen still needs network, and the UI says so.
export const FOOD_CACHE_LIMIT = 300;

// "full": a genuine server FoodItem (e.g. from a barcode resolve) — real
// provenance, real serving info, and (when the server has one) a barcode.
// "summary": synthesized from a gram-scaled serving total (a pin or saved
// meal item) via foodsFromPins/foodsFromSavedMeals below — exact per-100g
// macros, but no serving/provenance/barcode. upsertFoods uses this so a
// summary write can never clobber a full record already cached for the
// same id.
export type FoodFidelity = "full" | "summary";

type Entry = { item: FoodItem; lastUsedAt: number; fidelity: FoodFidelity };

function isEntry(e: unknown): e is Entry {
  const entry = e as Entry;
  return !!entry && !!entry.item && typeof entry.item.id === "string";
}

async function load(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Entries persisted before fidelity tracking existed have no `fidelity`
    // field; treat them as "full" so old cached data is never retroactively
    // treated as downgradable.
    return parsed.filter(isEntry).map((e) => ({ ...e, fidelity: e.fidelity ?? "full" }));
  } catch {
    return [];
  }
}

// upsertFoods is called from an effect keyed on query data (fidelity:
// "summary") or a mutation's onSuccess (fidelity: "full", the default), so it
// is a by-product of normal use — no sync job, no index versioning, nothing
// to go stale. Re-upserting an already-cached id at the SAME fidelity
// refreshes its lastUsedAt, which is what makes eviction below genuinely
// least-recently-USED rather than a simple truncation of insertion order.
//
// A "summary" write is refused outright when a "full" record already exists
// for that id: a real barcode scan carries a barcode, real provenance, and
// the canonical serving, and a later pins/saved-meals refetch synthesizing
// the SAME food from a gram-scaled total must not destroy that. Refusing to
// downgrade (rather than merging field-by-field) is the simpler rule to
// reason about, and it can never lose information a full record already had
// — the cost is that such a record's recency is not refreshed by a
// subsequent summary-only touch, which is an acceptable trade since nothing
// evicts a food the user keeps actually resolving at full fidelity.
export async function upsertFoods(items: FoodItem[], fidelity: FoodFidelity = "full"): Promise<void> {
  if (items.length === 0) return;
  const byId = new Map((await load()).map((e) => [e.item.id, e]));
  const now = Date.now();
  items.forEach((item, i) => {
    if (byId.get(item.id)?.fidelity === "full" && fidelity === "summary") return;
    byId.set(item.id, { item, lastUsedAt: now + i, fidelity });
  });

  const trimmed = [...byId.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, FOOD_CACHE_LIMIT);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export async function getFoodById(id: string): Promise<FoodItem | null> {
  return (await load()).find((e) => e.item.id === id)?.item ?? null;
}

export async function getFoodByBarcode(barcode: string): Promise<FoodItem | null> {
  return (await load()).find((e) => e.item.barcode === barcode)?.item ?? null;
}

export async function searchCachedFoods(q: string): Promise<FoodItem[]> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return (await load())
    .filter((e) => e.item.name.toLowerCase().includes(needle))
    .map((e) => e.item);
}

// --- Synthesizing FoodItems from gram-scaled serving summaries ---
//
// usePins/useSavedMeals never return a full FoodItem: the server (see
// api/internal/pins/service.go PinnedFood, api/internal/savedmeals/service.go
// SavedMealItemView) sends only a gram-scaled summary for that one serving —
// food_item_id + name + totals for `grams`, never per-100g macros, never
// brand/provenance/serving info, never a barcode.
//
// Derived via Pick from PinnedFood rather than redeclared: if the server
// response shape changes (e.g. a field rename), this fails to compile
// instead of silently caching nothing, which is the exact bug this replaced.
type ServingSummary = Pick<PinnedFood, "food_item_id" | "name" | "grams" | "kcal" | "protein_g" | "carbs_g" | "fat_g">;

// Reverses the server's own per-100g -> per-serving scaling exactly (plain
// division, not an estimate): the server computes a serving's totals as
// `kcal_per_100g * grams / 100` using unrounded float64, so `total * 100 /
// grams` recovers the original value (modulo float rounding, not truncation).
// brand/provenance/serving info are genuinely unknown at this shape, so they
// get honest empty/unknown values rather than a fabricated serving size —
// see UNKNOWN_PROVENANCE.
function foodFromServingSummary(f: ServingSummary): FoodItem | null {
  if (!f.food_item_id || !f.name || !(f.grams > 0)) return null;
  const scale = 100 / f.grams;
  return {
    id: f.food_item_id,
    name: f.name,
    brand: "",
    provenance: UNKNOWN_PROVENANCE,
    serving_desc: "",
    serving_grams: 0,
    kcal_per_100g: f.kcal * scale,
    protein_per_100g: f.protein_g * scale,
    carbs_per_100g: f.carbs_g * scale,
    fat_per_100g: f.fat_g * scale,
  };
}

export function foodsFromPins(pins: PinnedFood[]): FoodItem[] {
  return pins.map(foodFromServingSummary).filter((f): f is FoodItem => f !== null);
}

// The saved meal's OWN id/name (e.g. "My lunch") must never be mistaken for
// a food — only what's nested inside `items` belongs in the cache.
export function foodsFromSavedMeals(meals: SavedMeal[]): FoodItem[] {
  return meals.flatMap((m) => m.items.map(foodFromServingSummary).filter((f): f is FoodItem => f !== null));
}
