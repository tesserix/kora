import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodItem, PinnedFood, SavedMeal } from "@/api/types";
import { UNKNOWN_PROVENANCE } from "@/api/types";
import { createLock } from "./lock";

const STORAGE_KEY = "kora.foodCache";

// upsertFoods is a read-modify-write over the whole cache and its callers are
// effects on independent queries — usePins and useSavedMeals routinely resolve
// in the same tick. Unserialised, one fill clobbers the other and half the
// user's foods are simply missing offline. Its own lock, independent of the
// queue's: the two have no ordering relationship. See src/offline/lock.ts.
const withCacheLock = createLock();

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
// summary write can never blank a field a full record already had.
export type FoodFidelity = "full" | "summary";
const FIDELITIES: FoodFidelity[] = ["full", "summary"];

type Entry = { item: FoodItem; lastUsedAt: number; fidelity: FoodFidelity };

function isEntry(e: unknown): e is Entry {
  const entry = e as Entry;
  return !!entry && !!entry.item && typeof entry.item.id === "string" &&
    (entry.fidelity === undefined || FIDELITIES.includes(entry.fidelity));
}

async function load(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Entries persisted before fidelity tracking existed (or a corrupt
    // `fidelity` value caught above) have no valid `fidelity`. Every writer
    // that predates this field was the summary path (usePins/useSavedMeals
    // shipped first), so those records carry `provenance: "cached"` and a
    // fabricated serving — defaulting to "full" would freeze those defects
    // in place forever. "summary" is the honest default: self-healing, and a
    // later full write (e.g. a barcode scan) can still upgrade it.
    return parsed.filter(isEntry).map((e) => ({ ...e, fidelity: e.fidelity ?? "summary" }));
  } catch {
    return [];
  }
}

// A "summary" write into an id that already holds a "full" record MERGES
// rather than replaces or refuses: it takes what a summary genuinely knows
// (name — the server may have corrected it — and per-100g macros, an exact
// reverse-scale of a fresh total) but keeps what it cannot know (barcode,
// real provenance, canonical serving) from the full record. This is
// deliberately not a "refuse" rule: refusing a downgrade also means refusing
// to touch `lastUsedAt`, which sinks the full record's recency every time
// something ELSE gets touched — the exact records this fidelity system
// exists to protect would be the first evicted at the cap.
function mergeSummaryIntoFull(existingItem: FoodItem, incoming: FoodItem): FoodItem {
  return {
    ...existingItem,
    name: incoming.name,
    kcal_per_100g: incoming.kcal_per_100g,
    protein_per_100g: incoming.protein_per_100g,
    carbs_per_100g: incoming.carbs_per_100g,
    fat_per_100g: incoming.fat_per_100g,
  };
}

// upsertFoods is called from an effect keyed on query data (fidelity:
// "summary") or a mutation's onSuccess (fidelity: "full", the default), so it
// is a by-product of normal use — no sync job, no index versioning, nothing
// to go stale. EVERY touch — full or summary, merged or not — refreshes
// lastUsedAt, which is what makes eviction below genuinely
// least-recently-USED rather than a simple truncation of insertion order.
export function upsertFoods(items: FoodItem[], fidelity: FoodFidelity = "full"): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return withCacheLock(async () => {
    const byId = new Map((await load()).map((e) => [e.item.id, e]));
    const now = Date.now();
    items.forEach((item, i) => {
      const existing = byId.get(item.id);
      const keepsFull = fidelity === "summary" && existing?.fidelity === "full";
      const mergedItem = keepsFull ? mergeSummaryIntoFull(existing.item, item) : item;
      byId.set(item.id, { item: mergedItem, lastUsedAt: now + i, fidelity: keepsFull ? "full" : fidelity });
    });

    const trimmed = [...byId.values()]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, FOOD_CACHE_LIMIT);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  });
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

// query.data is typed as PinnedFood[]/SavedMeal[] only via an unvalidated
// `apiFetch(...) as Promise<...>` cast at the call site — a truthy non-array
// response, or a meal missing `items`, would throw synchronously inside the
// effect that calls this, OUTSIDE cacheFoodsQuietly's `.catch`, breaking the
// screen rather than just the cache fill. Both Go handlers do initialize
// these as real (possibly empty) arrays in practice, but these guards are the
// cost of not trusting that across a service boundary.
export function foodsFromPins(pins: PinnedFood[]): FoodItem[] {
  if (!Array.isArray(pins)) return [];
  return pins.map(foodFromServingSummary).filter((f): f is FoodItem => f !== null);
}

// The saved meal's OWN id/name (e.g. "My lunch") must never be mistaken for
// a food — only what's nested inside `items` belongs in the cache.
export function foodsFromSavedMeals(meals: SavedMeal[]): FoodItem[] {
  if (!Array.isArray(meals)) return [];
  return meals.flatMap((m) => (Array.isArray(m?.items) ? m.items : []).map(foodFromServingSummary).filter((f): f is FoodItem => f !== null));
}
