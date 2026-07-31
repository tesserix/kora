import { useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { foodVisual } from "@/lib/foodVisual";
import { haptics } from "@/motion";
import { useEditLog, useDeleteLog, useLog, useRepeatLog, type EditLogInput } from "@/api/hooks";
import type { FoodItem, FoodLog } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";

const SLOT_OPTIONS: Array<{ key: MealSlot; label: string }> = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function MealDetail() {
  const { colors } = useTheme();
  const p = useLocalSearchParams<{
    id: string; name: string; mealSlot: string; time: string;
    kcal: string; protein: string; carbs: string; fat: string; grams: string;
  }>();

  const { data: log } = useLog(p.id);
  // Overwritten with the PATCH response right after a successful food change,
  // so the displayed macros come straight from the server — never a local
  // recomputation off the picker's kcal_per_100g.
  const [override, setOverride] = useState<FoodLog | null>(null);
  const effective = override ?? log;

  // Paint instantly from the diary's route params (it already knows the name,
  // kcal and macros), then prefer the fetched/patched log once it's in.
  const name = effective?.description ?? p.name ?? "Meal";
  const vis = foodVisual(name, p.mealSlot);
  const baseGrams = effective?.quantity_grams ?? (Number(p.grams) || 0);
  const baseKcal = effective?.kcal ?? (Number(p.kcal) || 0);
  const baseProtein = effective?.protein_g ?? (Number(p.protein) || 0);
  const baseCarbs = effective?.carbs_g ?? (Number(p.carbs) || 0);
  const baseFat = effective?.fat_g ?? (Number(p.fat) || 0);

  const [grams, setGrams] = useState(baseGrams);
  const [slot, setSlot] = useState<MealSlot>((p.mealSlot as MealSlot) ?? "breakfast");
  const [err, setErr] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  const editLog = useEditLog();
  const deleteLog = useDeleteLog();
  const repeatLog = useRepeatLog();
  const busy = editLog.isPending || deleteLog.isPending || repeatLog.isPending;

  const scale = (base: number) => (baseGrams > 0 ? Math.round(base * grams / baseGrams) : base);
  const kcal = scale(baseKcal);
  // Same fallback pattern as baseGrams: prefer the effective (fetched/patched)
  // log's slot, and only fall back to the route param before it lands. Using
  // p.mealSlot here unconditionally would compare against a baseline that
  // never updates once the server's slot is known.
  const baseSlot = (effective?.meal_slot as MealSlot | undefined) ?? (p.mealSlot as MealSlot);
  const dirty = grams !== baseGrams || slot !== baseSlot;

  // A successful food change replaces the food identity but keeps the same
  // portion/slot, so resync local state to the server's response rather than
  // leaving Save changes armed for no user-made edit.
  useEffect(() => {
    if (!override) return;
    setGrams(override.quantity_grams);
    setSlot(override.meal_slot as MealSlot);
  }, [override]);

  const onSelectFood = (item: FoodItem) => {
    setPickerVisible(false);
    setErr(null);
    // Send the user's current portion/slot alongside the food change so the
    // server applies all three together. Otherwise a PATCH with only
    // food_item_id would echo back the log's ORIGINAL grams/slot, and the
    // effect below would force-resync local state to that echo — silently
    // discarding any unsaved portion or meal-slot edit the user just made.
    // A same-value field is a harmless no-op on the server.
    editLog.mutate(
      { id: p.id, food_item_id: item.id, quantity_grams: grams, meal_slot: slot },
      {
        onSuccess: ({ log: updated }) => {
          haptics.success();
          setOverride(updated);
        },
        onError: () => {
          haptics.error();
          setErr("Couldn't change the food. Try again.");
        },
      },
    );
  };

  const onSave = () => {
    if (!dirty || busy) return;
    setErr(null);
    const patch: EditLogInput = { id: p.id };
    if (grams !== baseGrams) patch.quantity_grams = grams;
    if (slot !== baseSlot) patch.meal_slot = slot;
    editLog.mutate(patch, {
      onSuccess: () => {
        haptics.success();
        router.back();
      },
      onError: () => {
        haptics.error();
        setErr("Couldn't save changes. Try again.");
      },
    });
  };

  const onDelete = () => {
    if (busy) return;
    Alert.alert("Delete this entry?", "This removes it from your diary.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteLog.mutate(p.id, {
            onSuccess: () => router.back(),
            onError: () => setErr("Couldn't delete. Try again."),
          }),
      },
    ]);
  };

  const onRepeat = () => {
    if (busy) return;
    setErr(null);
    repeatLog.mutate(p.id, {
      onSuccess: () => {
        haptics.success();
        router.back();
        Alert.alert("Logged again", "Added to today's diary.");
      },
      onError: () => {
        haptics.error();
        setErr("Couldn't repeat. Try again.");
      },
    });
  };

  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.cardSecondary,
            }}
          >
            <Icon name={vis.icon} size={28} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="title2">{name}</AppText>
            <AppText variant="footnote" muted style={{ marginTop: 2 }}>
              {cap(p.mealSlot)} · {p.time}
            </AppText>
          </View>
          <Stat label="Calories" value={String(kcal)} unit="kcal" />
        </View>

        <Card variant="elevated" style={{ flexDirection: "row", marginBottom: 20 }}>
          <View style={{ flex: 1 }}>
            <Stat label="Protein" value={String(scale(baseProtein))} unit="g" valueColor={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Stat label="Carbs" value={String(scale(baseCarbs))} unit="g" valueColor={colors.accentAmber} />
          </View>
          <View style={{ flex: 1 }}>
            <Stat label="Fat" value={String(scale(baseFat))} unit="g" valueColor={colors.accentBlue} />
          </View>
        </Card>

        <Overline>Portion</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, marginTop: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change food"
            disabled={busy}
            onPress={() => setPickerVisible(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
          >
            <AppText variant="subheadline" style={{ fontWeight: "600" }}>{name}</AppText>
            <Icon name="chevron-right" size={14} color={colors.tertiaryLabel} />
          </Pressable>
          <Stepper value={grams} onChange={setGrams} step={10} min={10} />
        </View>

        <Overline style={{ marginTop: 8 }}>Meal</Overline>
        <View style={{ marginTop: 8, marginBottom: 20 }}>
          <Segmented options={SLOT_OPTIONS} value={slot} onChange={(key) => setSlot(key as MealSlot)} />
        </View>

        {err ? (
          <AppText variant="footnote" style={{ color: colors.destructive, marginBottom: 12 }}>
            {err}
          </AppText>
        ) : null}

        <View style={{ gap: 10 }}>
          <Button title="Save changes" onPress={onSave} disabled={!dirty || busy} />
          <Button
            title="Repeat"
            variant="secondary"
            icon="repeat"
            accessibilityLabel="Repeat entry"
            disabled={busy}
            onPress={onRepeat}
          />
          <Button
            title="Remove"
            variant="destructive"
            icon="trash-2"
            accessibilityLabel="Delete entry"
            disabled={busy}
            onPress={onDelete}
          />
        </View>
      </View>

      <FoodPicker
        visible={pickerVisible}
        initialQuery={log?.input_phrase ?? name}
        onSelect={onSelectFood}
        onClose={() => setPickerVisible(false)}
      />
    </Sheet>
  );
}
