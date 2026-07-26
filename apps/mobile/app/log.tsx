import { useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { FoodTile } from "@/components/FoodTile";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Stat } from "@/components/Stat";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { useCreateLog, useFoodSearch } from "@/api/hooks";
import type { FoodItem } from "@/api/types";
import { foodVisual } from "@/lib/foodVisual";
import { haptics } from "@/motion";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
const MEAL_OPTIONS = MEALS.map((m) => ({ key: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));

export default function LogScreen() {
  const { colors, spacing, radius, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const mountedAt = useRef(Date.now());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState("");
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const [error, setError] = useState<string | null>(null);
  const search = useFoodSearch(q);
  const createLog = useCreateLog();

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (refetches update results in place, no re-stagger).
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  const filledInputStyle = {
    backgroundColor: colors.cardSecondary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
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
        onSuccess: () => {
          haptics.success();
          router.replace("/");
        },
        onError: () => setError("Couldn't log that. Please try again."),
      },
    );
  }

  if (selected) {
    const g = Number(grams) || selected.serving_grams || 100;
    const scale = g / 100;
    const vis = foodVisual(selected.name, meal);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, paddingTop: insets.top + spacing.lg, gap: spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <FoodTile hue={vis.hue} icon={vis.icon} size={64} radius={radius.xl} />
          <View style={{ flex: 1, gap: 4 }}>
            <AppText variant="title2">{selected.name}</AppText>
            <ProvenanceChip provenance={selected.provenance} />
          </View>
        </View>

        <Card style={{ flexDirection: "row" }}>
          <View style={{ flex: 1 }}>
            <Stat
              label="Protein"
              value={String(Math.round(selected.protein_per_100g * scale))}
              unit="g"
              valueColor={colors.accent}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Stat
              label="Carbs"
              value={String(Math.round(selected.carbs_per_100g * scale))}
              unit="g"
              valueColor={colors.accentAmber}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Stat
              label="Fat"
              value={String(Math.round(selected.fat_per_100g * scale))}
              unit="g"
              valueColor={colors.accentBlue}
            />
          </View>
        </Card>

        <TextInput
          accessibilityLabel="Quantity in grams"
          style={filledInputStyle}
          placeholder={`Grams (default ${selected.serving_grams || 100})`}
          placeholderTextColor={colors.secondaryLabel}
          keyboardType="decimal-pad"
          value={grams}
          onChangeText={setGrams}
        />

        <Segmented options={MEAL_OPTIONS} value={meal} onChange={(key) => setMeal(key as (typeof MEALS)[number])} />

        {error ? (
          <AppText variant="footnote" style={{ color: colors.destructive }}>
            {error}
          </AppText>
        ) : null}
        <Button title={createLog.isPending ? "Logging…" : "Log it"} onPress={submit} disabled={createLog.isPending} />
        <Button title="Back" variant="ghost" onPress={() => setSelected(null)} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top + 8 }}>
      <ScreenHeader overline="Add to diary" title="Log food" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            backgroundColor: colors.cardSecondary,
            borderRadius: radius.lg,
            paddingHorizontal: spacing.md,
          }}
        >
          <Icon name="search" size={18} color={colors.secondaryLabel} />
          <TextInput
            accessibilityLabel="Search foods"
            style={{ flex: 1, color: colors.label, fontSize: fontSize.base, paddingVertical: 12 }}
            placeholder="Search foods…"
            placeholderTextColor={colors.secondaryLabel}
            autoFocus
            value={q}
            onChangeText={setQ}
          />
        </View>

        {search.data && search.data.length > 0 ? (
          <GroupedSection>
            {search.data.map((item, i) => (
              <Animated.View key={item.id} entering={enter(i)}>
                <Row
                  title={item.name}
                  subtitle={item.brand || undefined}
                  detail={`${Math.round(item.kcal_per_100g)} kcal/100g`}
                  onPress={() => setSelected(item)}
                />
              </Animated.View>
            ))}
          </GroupedSection>
        ) : q.length >= 2 && !search.isLoading ? (
          <AppText muted>No matches.</AppText>
        ) : null}
      </ScrollView>
    </View>
  );
}
