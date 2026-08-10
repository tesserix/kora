import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Icon } from "@/components/Icon";
import { PortionField } from "@/components/units/PortionField";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { useCreateSavedMeal, useUpdateSavedMeal, useDeleteSavedMeal } from "@/api/hooks";
import type { FoodItem, MemoryFood, MemoryMeal, SavedMeal, SavedMealItem } from "@/api/types";
import type { ServingUnit } from "@/units/portion";
import { baseQuantityFor, defaultServingCount } from "@/units/portion";
import { useTheme } from "@/theme";

const SLOT_OPTIONS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

// `grams` is the base-unit (server) figure and only changes when the user
// edits the exact-mode field in grams. `enteredAmount`/`enteredUnit` track a
// named-serving entry (e.g. "2 sachet") separately — when `enteredUnit` is
// set, THAT pair is what gets sent on save, never `grams`, matching the
// server-resolves-grams contract meal.tsx follows for a single log.
//
// `rowId` is CLIENT-ONLY identity for React's list reconciliation — never
// sent to the server (save() builds its own payload shape and never spreads
// an EditItem into it). Two rows can legitimately share the same
// food_item_id (two different portions of the same food logged separately),
// so food_item_id alone is not a safe key: with duplicate keys, React can
// reattribute PortionField's local exact-mode state from one row to another
// when a sibling row is removed. rowId is generated once, when the row is
// created (seeded or added), and never regenerated on re-render.
type EditItem = {
  rowId: string;
  food_item_id: string;
  name: string;
  grams: number;
  enteredAmount: number | null;
  enteredUnit: string | null;
};

// Collision-improbable local id — these ids never leave the device (they
// exist only for React list keys), so a uuid dependency is unnecessary. Same
// scheme as src/reminders/customPrefs.ts's newId().
function newRowId(): string {
  return `row_${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// A saved-meal item carries the user's entered pair when it has one
// (MemoryFood — the "usual meal" aggregate a create-seed comes from — never
// does; only a real SavedMealItem can). The "in" checks are what let this
// read either union member without a false type error.
function enteredPairOf(i: MemoryFood | SavedMealItem): { amount: number | null; unit: string | null } {
  const amount = "entered_amount" in i && typeof i.entered_amount === "number" ? i.entered_amount : null;
  const unit = "entered_unit" in i && i.entered_unit ? i.entered_unit : null;
  return { amount, unit };
}

// Neither MemoryFood nor SavedMealItem carries the food's base unit or full
// serving catalog (that isn't joined into the saved-meals response) — same
// limitation as meal.tsx's servingUnitsFor, and the same fix: synthesize the
// single serving actually in use from the entered pair and the resolved
// grams, so PortionField can still render the stepper for it.
function servingUnitsFor(item: EditItem): ServingUnit[] {
  if (item.enteredUnit && item.enteredAmount && item.enteredAmount > 0) {
    return [{ name: item.enteredUnit, amount: 1, base_amount: item.grams / item.enteredAmount }];
  }
  return [];
}

// A composed row is seeded from selected diary entries — quantity_grams is
// the diary row's resolved grams, and entered_amount/entered_unit carry that
// row's original entered pair (if any) so the sheet's stepper opens on the
// same unit the user logged in, per servingUnitsFor's synthesis above.
export type ComposedItem = {
  food_item_id: string;
  name: string;
  quantity_grams: number;
  entered_amount: number | null;
  entered_unit: string | null;
  base_unit?: string | null;
};

// seed is a usual meal to save (create), an existing saved meal (edit), a
// blank sheet (new meal from scratch), or a set of diary rows to compose
// into a new meal (compose).
export type Seed =
  | { mode: "create"; meal: MemoryMeal }
  | { mode: "edit"; meal: SavedMeal }
  | { mode: "blank" }
  | { mode: "compose"; items: ComposedItem[] };

interface Props {
  seed: Seed | null;
  onClose: () => void;
}

export function SavedMealSheet({ seed, onClose }: Props) {
  const { colors, spacing, radius } = useTheme();
  const createMeal = useCreateSavedMeal();
  const updateMeal = useUpdateSavedMeal();
  const deleteMeal = useDeleteSavedMeal();

  const [name, setName] = useState("");
  const [slot, setSlot] = useState("breakfast");
  const [items, setItems] = useState<EditItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!seed) return;
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
          rowId: newRowId(),
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
    setName(seed.meal.name);
    setSlot(seed.meal.meal_slot);
    setItems(
      seed.meal.items.map((i) => {
        const { amount, unit } = enteredPairOf(i);
        return { rowId: newRowId(), food_item_id: i.food_item_id, name: i.name, grams: i.grams, enteredAmount: amount, enteredUnit: unit };
      }),
    );
    setErr(null);
  }, [seed]);

  const removeItem = (idx: number) => setItems((cur) => cur.filter((_, i) => i !== idx));

  // Seeded exactly as app/log.tsx's selectFood seeds its own selection, so a
  // picked sachet lands as "1 portion" rather than "16.5 g" — a QUANTITY
  // derived from figures the food row already carries, never a unit
  // conversion or a computed nutrition value. Appends rather than replaces:
  // adding to an existing saved meal (edit/compose seeds) is a real case,
  // not just building a blank one from scratch.
  const addItem = (food: FoodItem) => {
    setPickerOpen(false);
    const servingUnits = food.serving_units ?? [];
    const defaultServing = servingUnits[0] ?? null;
    let newItem: EditItem;
    if (defaultServing) {
      const count = defaultServingCount(food.serving_grams, defaultServing);
      newItem = {
        rowId: newRowId(),
        food_item_id: food.id,
        name: food.name,
        grams: (baseQuantityFor(count, defaultServing.name, servingUnits) ?? food.serving_grams) || 100,
        enteredAmount: count,
        enteredUnit: defaultServing.name,
      };
    } else {
      newItem = {
        rowId: newRowId(),
        food_item_id: food.id,
        name: food.name,
        grams: food.serving_grams || 100,
        enteredAmount: null,
        enteredUnit: null,
      };
    }
    setItems((cur) => [...cur, newItem]);
  };
  const setPortion = (idx: number, amount: number, unit: string) =>
    setItems((cur) =>
      cur.map((it, i) =>
        i !== idx
          ? it
          : unit === "g"
            ? { ...it, grams: amount, enteredAmount: null, enteredUnit: null }
            : { ...it, enteredAmount: amount, enteredUnit: unit },
      ),
    );

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr("Enter a name."); return; }
    const parsed = items.map((it) =>
      it.enteredUnit !== null
        ? {
            food_item_id: it.food_item_id,
            // The server resolves grams from the entered pair — this 0 is a
            // required-field placeholder, never used as-is (see
            // savedmeals/service.go validate()).
            grams: 0,
            entered_amount: it.enteredAmount ?? undefined,
            entered_unit: it.enteredUnit,
          }
        : { food_item_id: it.food_item_id, grams: it.grams },
    );
    const invalid = parsed.some((p) =>
      "entered_unit" in p ? !((p.entered_amount ?? 0) > 0) : !(p.grams > 0),
    );
    if (parsed.length === 0 || invalid) { setErr("Add at least one item with grams."); return; }
    const body = { name: trimmed, meal_slot: slot, items: parsed };
    if (seed?.mode === "edit") {
      updateMeal.mutate({ id: seed.meal.id, body }, { onSuccess: onClose, onError: () => setErr("Couldn't save. Please try again.") });
    } else {
      createMeal.mutate(body, { onSuccess: onClose, onError: () => setErr("Couldn't save. Please try again.") });
    }
  };

  const remove = () => {
    if (seed?.mode === "edit") deleteMeal.mutate(seed.meal.id, { onSuccess: onClose, onError: () => setErr("Couldn't delete. Please try again.") });
  };

  const pending = createMeal.isPending || updateMeal.isPending || deleteMeal.isPending;
  // Mirrors save()'s validation so an empty/blank sheet reads as "not ready
  // yet" rather than surfacing the "Add at least one item with grams." error
  // the user hasn't actually caused. save() keeps its own check as a
  // backstop for any state this gate doesn't cover.
  const canSave = name.trim().length > 0 && items.length > 0 && items.every((it) => it.grams > 0 || (it.enteredAmount ?? 0) > 0);

  return (
    <Sheet visible={seed !== null} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{seed?.mode === "edit" ? "Edit saved meal" : "Save meal"}</Overline>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Meal name"
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel="Meal name"
          style={{ fontSize: 20, color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, marginTop: spacing.md }}
        />
        <View style={{ marginTop: spacing.md }}>
          <Segmented options={SLOT_OPTIONS} value={slot} onChange={setSlot} />
        </View>
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          {items.map((it, idx) => (
            <View key={it.rowId} style={{ gap: spacing.xs }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <AppText style={{ flex: 1 }}>{it.name}</AppText>
                <Pressable accessibilityLabel={`Remove ${it.name}`} hitSlop={8} onPress={() => removeItem(idx)}>
                  <Icon name="minus" size={20} color={colors.destructive} />
                </Pressable>
              </View>
              <PortionField
                baseUnit="g"
                servingUnits={servingUnitsFor(it)}
                amount={it.enteredUnit !== null ? (it.enteredAmount ?? it.grams) : it.grams}
                unit={it.enteredUnit ?? "g"}
                onChange={(amount, unit) => setPortion(idx, amount, unit)}
              />
            </View>
          ))}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Add ingredient" onPress={() => setPickerOpen(true)}>
          <AppText style={{ color: colors.accent, marginTop: spacing.sm }}>+ Add ingredient</AppText>
        </Pressable>
        <FoodPicker visible={pickerOpen} initialQuery="" onSelect={addItem} onClose={() => setPickerOpen(false)} />
        {err ? <AppText style={{ color: colors.destructive, marginTop: spacing.sm }}>{err}</AppText> : null}
        <View style={{ marginTop: spacing.lg }}>
          <Button accessibilityLabel="Save" title="Save" onPress={save} disabled={pending || !canSave} />
        </View>
        {seed?.mode === "edit" ? (
          <Pressable onPress={remove} disabled={pending} style={{ marginTop: spacing.md, alignItems: "center" }}>
            <AppText style={{ color: colors.destructive }}>Delete saved meal</AppText>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
