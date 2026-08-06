import { useEffect, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { Stat } from "@/components/Stat";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { AppBackground } from "@/components/AppBackground";
import { Overline } from "@/components/Overline";
import { useCreateLog, useFoodSearch, useMemory, usePins, useSavedMeals } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { usePinToggle } from "@/api/usePinToggle";
import type { FoodItem } from "@/api/types";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";
import { haptics } from "@/motion";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
const MEAL_OPTIONS = MEALS.map((m) => ({ key: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));
const MEMORY_TAB_OPTIONS: { key: string; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "pinned", label: "Pinned" },
  { key: "recents", label: "Recents" },
  { key: "frequent", label: "Frequent" },
  { key: "usual_meals", label: "Usual meals" },
];

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

// expo-router hands back an array when a query key repeats — take the first
// value, same as every other multi-param screen in this app.
function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// A capture's seeded `loggedAt` is a route param, not a trusted server value —
// validate it parses to a real instant before trusting it for logged_at, so a
// malformed or missing deep link falls back to now rather than sending the
// server an Invalid Date string.
function parseSeededLoggedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export default function LogScreen() {
  const { colors, spacing, fontSize } = useTheme();
  const insets = useSafeAreaInsets();
  const { loggedAt } = useLocalSearchParams<{ loggedAt?: string | string[] }>();
  // Seeded from a failed capture's own capture time (app/capture-review.tsx's
  // "Log it manually") so the entry lands on the day the meal actually
  // happened, never the day it was cleaned up — the same #84-adjacent
  // invariant handleConfirm's logged_at enforces for the automatic path.
  const seededLoggedAt = parseSeededLoggedAt(firstParam(loggedAt));
  const mountedAt = useRef(Date.now());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<FoodItem | null>(null);
  const [grams, setGrams] = useState("");
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const [error, setError] = useState<string | null>(null);
  const [memTab, setMemTab] = useState<"saved" | "pinned" | "recents" | "frequent" | "usual_meals">("recents");
  const search = useFoodSearch(q);
  const createLog = useCreateLog();
  const memory = useMemory(today());
  const pins = usePins();
  const savedMeals = useSavedMeals();
  const { pinnedIds, toggle } = usePinToggle();
  const { logFood, logMeal } = useInstantLog();
  const { openCreate, openEdit } = useSavedMealEditor();

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (refetches update results in place, no re-stagger).
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  const filledInputStyle = {
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
        logged_at: seededLoggedAt ?? new Date().toISOString(),
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
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppBackground />
        <View style={{ flex: 1, padding: spacing.lg, paddingTop: insets.top + spacing.lg, gap: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
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
            <View style={{ flex: 1, gap: 4 }}>
              <AppText variant="title2">{selected.name}</AppText>
              <ProvenanceChip provenance={selected.provenance} />
            </View>
          </View>

          <Card variant="elevated" style={{ flexDirection: "row" }}>
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

          <Overline>Portion</Overline>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Quantity in grams"
              style={filledInputStyle}
              placeholder={`Grams (default ${selected.serving_grams || 100})`}
              placeholderTextColor={colors.secondaryLabel}
              keyboardType="decimal-pad"
              value={grams}
              onChangeText={setGrams}
            />
          </Card>

          <Overline>Meal</Overline>
          <Segmented options={MEAL_OPTIONS} value={meal} onChange={(key) => setMeal(key as (typeof MEALS)[number])} />

          {error ? (
            <AppText variant="footnote" style={{ color: colors.destructive }}>
              {error}
            </AppText>
          ) : null}
          <Button title={createLog.isPending ? "Logging…" : "Log it"} onPress={submit} disabled={createLog.isPending} />
          <Button title="Back" variant="ghost" onPress={() => setSelected(null)} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <View style={{ flex: 1, paddingTop: insets.top + 8 }}>
        <ScreenHeader overline="Add to diary" title="Log food" onBack={() => router.back()} />
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: spacing.md }}
          keyboardShouldPersistTaps="handled"
        >
          <Card variant="elevated" style={{ padding: 0 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.sm,
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
          </Card>

          {q.length < 2 ? (
            <>
              <Segmented
                options={MEMORY_TAB_OPTIONS}
                value={memTab}
                onChange={(key) => setMemTab(key as typeof memTab)}
              />
              {memory.isLoading ? (
                <AppText muted>Loading…</AppText>
              ) : memory.isError ? (
                <AppText muted>Couldn't load your foods.</AppText>
              ) : memTab === "saved" ? (
                (savedMeals.data ?? []).length > 0 ? (
                  <GroupedSection elevated>
                    {(savedMeals.data ?? []).map((m) => {
                      const fv = foodVisual(m.name);
                      return (
                        <MealRow
                          key={m.id}
                          name={m.name}
                          slot={m.items.map((i) => i.name).join(" · ")}
                          kcal={m.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => logMeal(m)}
                          bookmarked
                          onBookmark={() => openEdit(m)}
                          accessibilityLabel={m.name}
                        />
                      );
                    })}
                  </GroupedSection>
                ) : (
                  <AppText muted>Save a usual meal to see it here.</AppText>
                )
              ) : memTab === "pinned" ? (
                (pins.data ?? []).length > 0 ? (
                  <GroupedSection elevated>
                    {(pins.data ?? []).map((f) => {
                      const fv = foodVisual(f.name);
                      return (
                        <MealRow
                          key={f.food_item_id}
                          name={f.name}
                          slot={`${Math.round(f.grams)}g`}
                          kcal={f.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => logFood(f)}
                          pinned
                          onPinToggle={() => toggle(f)}
                          accessibilityLabel={f.name}
                        />
                      );
                    })}
                  </GroupedSection>
                ) : (
                  <AppText muted>Star a food to pin it here.</AppText>
                )
              ) : memTab === "usual_meals" ? (
                (memory.data?.usual_meals ?? []).length > 0 ? (
                  <GroupedSection elevated>
                    {(memory.data?.usual_meals ?? []).map((m) => {
                      const fv = foodVisual(m.name);
                      return (
                        <MealRow
                          key={m.id}
                          name={m.name}
                          slot={m.items.map((i) => i.name).join(" · ")}
                          kcal={m.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => logMeal(m)}
                          onBookmark={() => openCreate(m)}
                          accessibilityLabel={m.name}
                        />
                      );
                    })}
                  </GroupedSection>
                ) : (
                  <AppText muted>Log a few meals and they'll show up here.</AppText>
                )
              ) : (memory.data?.[memTab as "recents" | "frequent"] ?? []).length > 0 ? (
                <GroupedSection elevated>
                  {(memory.data?.[memTab as "recents" | "frequent"] ?? []).map((f) => {
                    const fv = foodVisual(f.name);
                    return (
                      <MealRow
                        key={f.food_item_id}
                        name={f.name}
                        slot={`${Math.round(f.grams)}g`}
                        kcal={f.kcal}
                        iconName={fv.icon}
                        tint={hslToHex(fv.hue, 0.5, 0.5)}
                        onPress={() => logFood(f)}
                        pinned={pinnedIds.has(f.food_item_id)}
                        onPinToggle={() => toggle(f)}
                        accessibilityLabel={f.name}
                      />
                    );
                  })}
                </GroupedSection>
              ) : (
                <AppText muted>Log a few meals and they'll show up here.</AppText>
              )}
            </>
          ) : null}

          {/* An offline search is a narrower thing than a server search: it can
              only find foods this device has already seen. Without saying so, a
              short list reads as "the food index barely has anything" and an
              empty one reads as "this food does not exist". */}
          {search.isOfflineCache && q.length >= 2 ? (
            <AppText variant="footnote" muted style={{ marginBottom: 8 }}>
              {search.data && search.data.length > 0
                ? "You're offline — showing foods you've logged before."
                : "You're offline, and you haven't logged anything matching that before."}
            </AppText>
          ) : null}

          {search.data && search.data.length > 0 ? (
            <GroupedSection elevated>
              {search.data.map((candidate, i) => {
                const item = candidate.item;
                const fv = foodVisual(item.name);
                return (
                  <Animated.View key={item.id} entering={enter(i)}>
                    <MealRow
                      name={item.name}
                      slot={item.brand || "per 100g"}
                      kcal={item.kcal_per_100g}
                      iconName={fv.icon}
                      tint={hslToHex(fv.hue, 0.5, 0.5)}
                      onPress={() => setSelected(item)}
                      accessibilityLabel={item.name}
                    />
                  </Animated.View>
                );
              })}
            </GroupedSection>
          ) : q.length >= 2 && !search.isLoading ? (
            // "No matches." asserts the food is not in the index. Offline we
            // cannot see the index at all, so the only honest thing to report
            // is the limitation — said above, which is why nothing is repeated
            // here.
            search.isOfflineCache ? null : <AppText muted>No matches.</AppText>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
