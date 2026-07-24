import { useRef, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Numeral } from "@/components/Numeral";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FoodTile } from "@/components/FoodTile";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useCreateLog, useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { foodVisual } from "@/lib/foodVisual";
import { tileFaint, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export default function LogScreen() {
  const { colors, spacing, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const mountedAt = useRef(Date.now());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState("");
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const [error, setError] = useState<string | null>(null);
  const search = useFoodSearch(q);
  const createLog = useCreateLog();

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  function submit() {
    if (!selected) return;
    createLog.mutate(
      {
        food_item_id: selected.id,
        meal_slot: meal,
        source: "manual",
        quantity_grams: Number(grams) || selected.serving_grams || 100,
        logged_at: new Date().toISOString(),
        client_log_ms: Date.now() - mountedAt.current,
      },
      {
        onSuccess: () => router.replace("/"),
        onError: () => setError("Couldn't log that. Please try again."),
      },
    );
  }

  if (selected) {
    const g = Number(grams) || selected.serving_grams || 100;
    const scale = g / 100;
    const macros: ReadonlyArray<readonly [string, string, number]> = [
      ["Protein", `${Math.round(selected.protein_per_100g * scale)}g`, MACRO.protein.hue],
      ["Carbs", `${Math.round(selected.carbs_per_100g * scale)}g`, MACRO.carbs.hue],
      ["Fat", `${Math.round(selected.fat_per_100g * scale)}g`, MACRO.fat.hue],
    ];
    const vis = foodVisual(selected.name, meal);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, paddingTop: insets.top + spacing.lg, gap: spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1 }}>
            <AppText style={{ fontSize: 20, fontWeight: "800", letterSpacing: -0.5 }}>{selected.name}</AppText>
            <ProvenanceChip provenance={selected.provenance} />
          </View>
        </View>

        <View style={{ flexDirection: "row", gap: 8 }}>
          {macros.map(([label, value, hue]) => (
            <View key={label} style={{ flex: 1, backgroundColor: tileFaint(hue), borderRadius: radius.lg, padding: 12 }}>
              <AppText muted style={{ fontSize: 11, fontWeight: "600" }}>{label}</AppText>
              <Numeral size={16} color={`hsl(${hue}, 55%, 38%)`}>{value}</Numeral>
            </View>
          ))}
        </View>

        <TextInput
          accessibilityLabel="Quantity in grams"
          style={inputStyle}
          placeholder={`Grams (default ${selected.serving_grams || 100})`}
          placeholderTextColor={colors.mutedForeground}
          keyboardType="decimal-pad"
          value={grams}
          onChangeText={setGrams}
        />
        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
          {MEALS.map((m) => (
            <Button key={m} title={m} variant={meal === m ? "primary" : "secondary"} onPress={() => setMeal(m)} />
          ))}
        </View>
        {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
        <Button title={createLog.isPending ? "Logging…" : "Log it"} onPress={submit} disabled={createLog.isPending} />
        <Button title="Back" variant="ghost" onPress={() => setSelected(null)} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 8 }}>
      <ScreenHeader overline="Add to diary" title="Log food" />
      <View style={{ paddingHorizontal: 20, gap: spacing.md, flex: 1 }}>
        <TextInput
          accessibilityLabel="Search foods"
          style={inputStyle}
          placeholder="Search foods…"
          placeholderTextColor={colors.mutedForeground}
          autoFocus
          value={q}
          onChangeText={setQ}
        />
        <FlatList
          data={search.data ?? []}
          keyExtractor={(item) => item.id}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
          renderItem={({ item }) => {
            const vis = foodVisual(item.name);
            return (
              <Pressable
                accessibilityRole="button"
                onPress={() => setSelected(item)}
                style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: 12, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
              >
                <FoodTile hue={vis.hue} icon={vis.icon} size={48} />
                <View style={{ flex: 1 }}>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{item.name}</AppText>
                  <AppText muted style={{ fontSize: 12, fontFamily: fonts.mono }}>
                    {Math.round(item.kcal_per_100g)} kcal/100g · {item.serving_desc}
                  </AppText>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={q.length >= 2 && !search.isLoading ? <AppText muted>No matches.</AppText> : null}
        />
      </View>
    </View>
  );
}
