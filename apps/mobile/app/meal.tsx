import { useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { FoodTile } from "@/components/FoodTile";
import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useEditLog, useDeleteLog, type EditLogInput } from "@/api/hooks";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";

const SLOTS: ReadonlyArray<MealSlot> = ["breakfast", "lunch", "dinner", "snack"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function MealDetail() {
  const { colors, radius, fonts } = useTheme();
  const p = useLocalSearchParams<{
    id: string; name: string; mealSlot: string; time: string;
    kcal: string; protein: string; carbs: string; fat: string; grams: string;
  }>();
  const name = p.name ?? "Meal";
  const vis = foodVisual(name, p.mealSlot);
  const baseGrams = Number(p.grams) || 0;
  const baseKcal = Number(p.kcal) || 0;

  const [grams, setGrams] = useState(baseGrams);
  const [slot, setSlot] = useState<MealSlot>((p.mealSlot as MealSlot) ?? "breakfast");
  const [err, setErr] = useState<string | null>(null);

  const editLog = useEditLog();
  const deleteLog = useDeleteLog();
  const busy = editLog.isPending || deleteLog.isPending;

  const scale = (base: number) => (baseGrams > 0 ? Math.round(base * grams / baseGrams) : base);
  const kcal = scale(baseKcal);
  const dirty = grams !== baseGrams || slot !== p.mealSlot;

  const tiles: ReadonlyArray<readonly [string, number, number]> = [
    ["Protein", scale(Number(p.protein) || 0), MACRO.protein.hue],
    ["Carbs", scale(Number(p.carbs) || 0), MACRO.carbs.hue],
    ["Fat", scale(Number(p.fat) || 0), MACRO.fat.hue],
  ];

  const onSave = () => {
    if (!dirty || busy) return;
    setErr(null);
    const patch: EditLogInput = { id: p.id };
    if (grams !== baseGrams) patch.quantity_grams = grams;
    if (slot !== p.mealSlot) patch.meal_slot = slot;
    editLog.mutate(patch, {
      onSuccess: () => router.back(),
      onError: () => setErr("Couldn't save changes. Try again."),
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

  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <Overline>{name} · {p.time}</Overline>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
              <Numeral size={24}>{String(kcal)}</Numeral>
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 14 }}>kcal</AppText>
            </View>
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8, marginBottom: 18 }}>
          {tiles.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{`${value}g`}</Numeral>
            </View>
          ))}
        </View>

        <Overline>Portion</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, marginTop: 6 }}>
          <AppText style={{ fontSize: 14, fontWeight: "600" }}>{name}</AppText>
          <Stepper value={grams} onChange={setGrams} step={10} min={10} />
        </View>

        <Overline style={{ marginTop: 8 }}>Meal</Overline>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 8, marginBottom: 20 }}>
          {SLOTS.map((s) => {
            const on = s === slot;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => setSlot(s)}
                style={{ flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.md, borderWidth: on ? 0 : 1, borderColor: colors.border, backgroundColor: on ? colors.primary : colors.card }}
              >
                <AppText style={{ fontSize: 12, fontWeight: "600", color: on ? colors.primaryForeground : colors.foreground }}>{cap(s)}</AppText>
              </Pressable>
            );
          })}
        </View>

        {err ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{err}</AppText> : null}

        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete entry"
            disabled={busy}
            onPress={onDelete}
            style={{ width: 48, height: 48, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", opacity: busy ? 0.5 : 1 }}
          >
            <Icon name="trash-2" size={18} color={colors.destructive} />
          </Pressable>
          <Button title="Save changes" onPress={onSave} disabled={!dirty || busy} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}
