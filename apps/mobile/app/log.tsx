import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
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
import { PortionField } from "@/components/units/PortionField";
import { useCreateLog, useFoodSearch, useMemory, usePins, useRecipes, useSavedMeals } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { usePinToggle } from "@/api/usePinToggle";
import type { FoodItem } from "@/api/types";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { RecipeParseSheet } from "@/components/recipes/RecipeParseSheet";
import { LogRecipeSheet } from "@/components/recipes/LogRecipeSheet";
import { baseQuantityFor, defaultServingCount, formatPortion } from "@/units/portion";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";
import { haptics } from "@/motion";
import { useTheme } from "@/theme";

const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
const MEAL_OPTIONS = MEALS.map((m) => ({ key: m, label: m.charAt(0).toUpperCase() + m.slice(1) }));
// The food-memory tabs carry two independent axes: what a row IS (a single
// food, or a meal made of several) and how it GOT there (you chose it, or the
// app inferred it). A single five-segment row stated neither, so every
// adjacent pair read as a synonym — "Pinned" beside "Saved", "Frequent" beside
// "Usual meals" — when each pair actually differs on the axis the label left
// out. Five segments was also past what the control holds at phone width;
// "Usual meals" wrapped to two lines and grew the row.
//
// So the food/meal axis moves up a tier where it is named, and each tier holds
// a comfortable number of tabs on the remaining axis.
const MEMORY_KIND_OPTIONS: { key: string; label: string }[] = [
  { key: "foods", label: "Foods" },
  { key: "meals", label: "Meals" },
];

// Single foods: pinned by hand, or inferred by recency and by count.
const FOOD_TAB_OPTIONS: { key: string; label: string }[] = [
  { key: "recents", label: "Recents" },
  { key: "frequent", label: "Frequent" },
  { key: "pinned", label: "Pinned" },
];

// Several foods together: built by hand, or inferred from foods repeatedly
// logged in the same day|slot. "Combos" rather than "Usual meals" — the
// grouping is what distinguishes it from Frequent, not the repetition they
// both share.
// A recipe is a third "several foods together" flavor, alongside Saved and
// Combos — built by hand from a pasted/photographed source rather than
// inferred from logging history. It belongs on this same tier for the same
// axis reason the comment above states, not a fourth top-level tier of its
// own.
const MEAL_TAB_OPTIONS: { key: string; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "usual_meals", label: "Combos" },
  { key: "recipes", label: "Recipes" },
];

type MemoryKind = "foods" | "meals";
type MemoryTab = "saved" | "pinned" | "recents" | "frequent" | "usual_meals" | "recipes";

// The tab a tier lands on when selected. Keeping this beside the option lists
// makes it a visible invariant that it is one of that tier's own tabs.
const FIRST_TAB_FOR_KIND: Record<MemoryKind, MemoryTab> = {
  foods: "recents",
  meals: "saved",
};

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
  // `grams` is the base-unit figure and is the ONLY thing the macro preview
  // below reads. It tracks the CURRENT portion whichever way it was entered:
  // a base-unit figure verbatim, or a named serving count multiplied by that
  // serving's own base_amount (the same conversion PortionField's "(30 g)"
  // hint shows). Letting it lag behind a serving entry is what made the card
  // preview one portion while a different one got logged.
  // `enteredAmount`/`enteredUnit` track a named serving entry (e.g. "1
  // sachet") separately; when `enteredUnit` is set that pair — not `grams` —
  // is what gets sent on submit, and the SERVER resolves quantity_grams from
  // it.
  const [grams, setGrams] = useState(100);
  const [enteredAmount, setEnteredAmount] = useState<number | null>(null);
  const [enteredUnit, setEnteredUnit] = useState<string | null>(null);
  const [meal, setMeal] = useState<(typeof MEALS)[number]>("lunch");
  const [error, setError] = useState<string | null>(null);
  const [memKind, setMemKind] = useState<MemoryKind>("foods");
  const [memTab, setMemTab] = useState<MemoryTab>(FIRST_TAB_FOR_KIND.foods);
  // "+ New recipe" opens the AI parse-review sheet; tapping a recipe row
  // opens the same servings/slot picker the recipe detail screen's own "Log"
  // button uses (LogRecipeSheet), seeded with that recipe's id/servings.
  const [parseSheetOpen, setParseSheetOpen] = useState(false);
  const [logRecipeTarget, setLogRecipeTarget] = useState<{ id: string; servings: number } | null>(null);
  const search = useFoodSearch(q);
  const createLog = useCreateLog();
  const memory = useMemory(today());
  const pins = usePins();
  const savedMeals = useSavedMeals();
  const recipes = useRecipes();
  const { pinnedIds, toggle } = usePinToggle();
  const { logFood, logMeal } = useInstantLog();
  const { openCreate, openEdit, openBlank } = useSavedMealEditor();

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (refetches update results in place, no re-stagger).
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  // Selecting a food seeds the portion from that food's own default serving
  // and base unit, resetting any previous selection's serving-mode edit —
  // otherwise a "2 sachet" entry for one food could silently survive onto a
  // food with no such serving at all.
  //
  // A food that HAS a named serving opens on it — one portion, shown as a
  // stepper — because that is the amount the user is overwhelmingly likely to
  // mean and the only entry mode that needs no arithmetic from them. Seeding
  // in exact mode instead put the serving's gram figure in the field, one tap
  // away from being reread as a serving count. A food with no named serving
  // falls back to raw base-unit entry, as before.
  //
  // The COUNT is not the unit's own `amount`: units.Parse normalises that to 1
  // so the unit describes ONE of the thing, while serving_grams keeps the full
  // label serving. Weet-Bix's "2 biscuits (30g)" would otherwise open on one
  // 15 g biscuit — half the portion the label describes.
  function selectFood(item: FoodItem) {
    const servingUnits = item.serving_units ?? [];
    const defaultServing = servingUnits[0] ?? null;
    setSelected(item);
    if (!defaultServing) {
      setGrams(item.serving_grams || 100);
      setEnteredAmount(null);
      setEnteredUnit(null);
      return;
    }
    const count = defaultServingCount(item.serving_grams, defaultServing);
    setEnteredAmount(count);
    setEnteredUnit(defaultServing.name);
    setGrams((baseQuantityFor(count, defaultServing.name, servingUnits) ?? item.serving_grams) || 100);
  }

  function submit() {
    if (!selected) return;
    const base = {
      food_item_id: selected.id,
      meal_slot: meal,
      source: "manual",
      logged_at: seededLoggedAt ?? new Date().toISOString(),
      client_log_ms: Date.now() - mountedAt.current,
    };
    // The client sends what the user entered; the SERVER resolves it into
    // quantity_grams. In exact/base-unit mode `grams` already IS that
    // figure, computed by nothing more than the user's own typed value.
    const input =
      enteredUnit !== null
        ? { ...base, quantity_grams: 0, entered_amount: enteredAmount ?? undefined, entered_unit: enteredUnit }
        : { ...base, quantity_grams: grams };
    createLog.mutate(input, {
      onSuccess: () => {
        haptics.success();
        router.replace("/");
      },
      onError: () => setError("Couldn't log that. Please try again."),
    });
  }

  if (selected) {
    const baseUnit: "g" | "ml" = selected.base_unit === "ml" ? "ml" : "g";
    const servingUnits = selected.serving_units ?? [];
    const portionUnit = enteredUnit ?? baseUnit;
    const portionAmount = enteredUnit !== null ? (enteredAmount ?? grams) : grams;
    const onPortionChange = (amount: number, unit: string) => {
      // An entry IN the food's own base unit is already the base-unit figure,
      // so the macro preview can follow it — no conversion is involved.
      if (unit === baseUnit) {
        setGrams(amount);
      } else {
        // A named serving: the row's own base_amount says what that portion is
        // in the base unit, and PortionField already shows exactly that figure
        // in its "(30 g)" hint. Keeping `grams` on it is what stops the macro
        // card describing one portion while a different one is logged. Still
        // no nutrition derived here — the SERVER resolves quantity_grams from
        // the entered pair.
        const base = baseQuantityFor(amount, unit, servingUnits);
        if (base !== null) setGrams(base);
      }
      // Only a GRAM entry may drop the entered pair. For a millilitre-based
      // food, "300 ml" entered as bare grams would be stored with a NULL unit
      // and read back as "300 g" forever. units.ToBase resolves ml→ml 1:1
      // server-side, so sending the pair costs nothing and keeps the row
      // honest about what the user meant.
      if (unit === "g") {
        setEnteredAmount(null);
        setEnteredUnit(null);
      } else {
        setEnteredAmount(amount);
        setEnteredUnit(unit);
      }
    };
    // Display-only preview — see the comment on `grams` above. The scaling
    // itself is never the client's business to persist: whatever this shows,
    // the SERVER recomputes nutrition from its own resolved quantity_grams.
    const scale = grams / 100;
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
          <PortionField
            baseUnit={baseUnit}
            servingUnits={servingUnits}
            amount={portionAmount}
            unit={portionUnit}
            onChange={onPortionChange}
          />

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
    <>
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
              <View style={{ gap: spacing.sm }}>
                <Segmented
                  options={MEMORY_KIND_OPTIONS}
                  value={memKind}
                  onChange={(key) => {
                    const kind = key as MemoryKind;
                    setMemKind(kind);
                    // Never leave the selection pointing into the tier we just
                    // left — that would render a meal list under Foods.
                    setMemTab(FIRST_TAB_FOR_KIND[kind]);
                  }}
                />
                <Segmented
                  options={memKind === "foods" ? FOOD_TAB_OPTIONS : MEAL_TAB_OPTIONS}
                  value={memTab}
                  onChange={(key) => setMemTab(key as MemoryTab)}
                />
              </View>
              {memory.isLoading ? (
                <AppText muted>Loading…</AppText>
              ) : memory.isError ? (
                <AppText muted>Couldn't load your foods.</AppText>
              ) : memTab === "saved" ? (
                <>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Overline>Saved</Overline>
                    <Pressable accessibilityRole="button" accessibilityLabel="New meal" onPress={openBlank}>
                      <AppText style={{ color: colors.accent }}>+ New meal</AppText>
                    </Pressable>
                  </View>
                  {(savedMeals.data ?? []).length > 0 ? (
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
                  )}
                </>
              ) : memTab === "recipes" ? (
                <>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Overline>Recipes</Overline>
                    <Pressable accessibilityRole="button" accessibilityLabel="New recipe" onPress={() => setParseSheetOpen(true)}>
                      <AppText style={{ color: colors.accent }}>+ New recipe</AppText>
                    </Pressable>
                  </View>
                  {(recipes.data ?? []).length > 0 ? (
                    <GroupedSection elevated>
                      {(recipes.data ?? []).map((r) => {
                        const fv = foodVisual(r.name);
                        return (
                          <MealRow
                            key={r.id}
                            name={r.name}
                            slot={`makes ${r.servings}`}
                            kcal={r.per_serving_kcal}
                            iconName={fv.icon}
                            tint={hslToHex(fv.hue, 0.5, 0.5)}
                            onPress={() => setLogRecipeTarget({ id: r.id, servings: r.servings })}
                            accessibilityLabel={r.name}
                          />
                        );
                      })}
                    </GroupedSection>
                  ) : (
                    <AppText muted>Paste or photograph a recipe to see it here.</AppText>
                  )}
                </>
              ) : memTab === "pinned" ? (
                (pins.data ?? []).length > 0 ? (
                  <GroupedSection elevated>
                    {(pins.data ?? []).map((f) => {
                      const fv = foodVisual(f.name);
                      return (
                        <MealRow
                          key={f.food_item_id}
                          name={f.name}
                          slot={formatPortion({ quantity_grams: f.grams })}
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
                        slot={formatPortion({ quantity_grams: f.grams })}
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
                      onPress={() => selectFood(item)}
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
    <RecipeParseSheet visible={parseSheetOpen} onClose={() => setParseSheetOpen(false)} />
    {logRecipeTarget ? (
      <LogRecipeSheet
        visible
        recipeId={logRecipeTarget.id}
        defaultServings={logRecipeTarget.servings}
        onClose={() => setLogRecipeTarget(null)}
      />
    ) : null}
    </>
  );
}
