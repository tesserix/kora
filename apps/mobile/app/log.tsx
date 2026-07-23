import { useRef, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useCreateLog, useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;

export default function LogScreen() {
  const { colors, spacing, radius } = useTheme();
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
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md }}>
        <AppText variant="h2">{selected.name}</AppText>
        <ProvenanceChip provenance={selected.provenance} />
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
    <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Log food</AppText>
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
        renderItem={({ item }) => (
          <Pressable onPress={() => setSelected(item)}>
            <Card>
              <AppText>{item.name}</AppText>
              <AppText muted>
                {Math.round(item.kcal_per_100g)} kcal/100g · {item.serving_desc}
              </AppText>
            </Card>
          </Pressable>
        )}
        ListEmptyComponent={q.length >= 2 && !search.isLoading ? <AppText muted>No matches.</AppText> : null}
      />
    </View>
  );
}
