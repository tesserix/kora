import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Segmented } from "@/components/Segmented";
import { Icon } from "@/components/Icon";
import { useCreateSavedMeal, useUpdateSavedMeal, useDeleteSavedMeal } from "@/api/hooks";
import type { MemoryMeal, SavedMeal } from "@/api/types";
import { useTheme } from "@/theme";

const SLOT_OPTIONS = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

type EditItem = { food_item_id: string; name: string; grams: string };

// seed is either a usual meal to save (create) or an existing saved meal (edit).
export type Seed = { mode: "create"; meal: MemoryMeal } | { mode: "edit"; meal: SavedMeal };

interface Props {
  seed: Seed | null;
  onClose: () => void;
}

export function SavedMealSheet({ seed, onClose }: Props) {
  const { colors, spacing, radius, fonts } = useTheme();
  const createMeal = useCreateSavedMeal();
  const updateMeal = useUpdateSavedMeal();
  const deleteMeal = useDeleteSavedMeal();

  const [name, setName] = useState("");
  const [slot, setSlot] = useState("breakfast");
  const [items, setItems] = useState<EditItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!seed) return;
    setName(seed.meal.name);
    setSlot(seed.meal.meal_slot);
    setItems(seed.meal.items.map((i) => ({ food_item_id: i.food_item_id, name: i.name, grams: String(Math.round(i.grams)) })));
    setErr(null);
  }, [seed]);

  const removeItem = (idx: number) => setItems((cur) => cur.filter((_, i) => i !== idx));
  const setGrams = (idx: number, g: string) => setItems((cur) => cur.map((it, i) => (i === idx ? { ...it, grams: g } : it)));

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr("Enter a name."); return; }
    const parsed = items.map((it) => ({ food_item_id: it.food_item_id, grams: Number(it.grams) }));
    if (parsed.length === 0 || parsed.some((p) => !(p.grams > 0))) { setErr("Add at least one item with grams."); return; }
    const body = { name: trimmed, meal_slot: slot, items: parsed };
    if (seed?.mode === "edit") {
      updateMeal.mutate({ id: seed.meal.id, body }, { onSuccess: onClose });
    } else {
      createMeal.mutate(body, { onSuccess: onClose });
    }
  };

  const remove = () => {
    if (seed?.mode === "edit") deleteMeal.mutate(seed.meal.id, { onSuccess: onClose });
  };

  const pending = createMeal.isPending || updateMeal.isPending || deleteMeal.isPending;

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
            <View key={it.food_item_id} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <AppText style={{ flex: 1 }}>{it.name}</AppText>
              <TextInput
                value={it.grams}
                onChangeText={(g) => setGrams(idx, g)}
                keyboardType="decimal-pad"
                accessibilityLabel={`${it.name} grams`}
                style={{ width: 72, textAlign: "right", color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, fontFamily: fonts.mono }}
              />
              <AppText muted>g</AppText>
              <Pressable accessibilityLabel={`Remove ${it.name}`} hitSlop={8} onPress={() => removeItem(idx)}>
                <Icon name="minus" size={20} color={colors.destructive} />
              </Pressable>
            </View>
          ))}
        </View>
        {err ? <AppText style={{ color: colors.destructive, marginTop: spacing.sm }}>{err}</AppText> : null}
        <View style={{ marginTop: spacing.lg }}>
          <Button title="Save" onPress={save} disabled={pending} />
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
