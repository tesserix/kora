import AsyncStorage from "@react-native-async-storage/async-storage";
import type { FoodItem } from "@/api/types";

const STORAGE_KEY = "kora.foodCache";

// A person's food vocabulary is small and highly repetitive, so a few hundred
// entries covers the overwhelming majority of repeat logging at trivial cost
// (~100KB). This is deliberately NOT a mirror of the 7,848-row server index:
// a food the device has never seen still needs network, and the UI says so.
export const FOOD_CACHE_LIMIT = 300;

type Entry = { item: FoodItem; lastUsedAt: number };

async function load(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && e.item && typeof e.item.id === "string");
  } catch {
    return [];
  }
}

// upsertFoods is called from an effect keyed on query data, so it is a
// by-product of normal use — no sync job, no index versioning, nothing to go
// stale. Re-upserting an already-cached id refreshes its lastUsedAt, which is
// what makes eviction below genuinely least-recently-USED rather than a
// simple truncation of insertion order.
export async function upsertFoods(items: FoodItem[]): Promise<void> {
  if (items.length === 0) return;
  const byId = new Map((await load()).map((e) => [e.item.id, e]));
  const now = Date.now();
  items.forEach((item, i) => byId.set(item.id, { item, lastUsedAt: now + i }));

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
