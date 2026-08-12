import { useState } from "react";
import { Alert, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Overline } from "@/components/Overline";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { LogRecipeSheet } from "@/components/recipes/LogRecipeSheet";
import { useToast } from "@/components/Toast";
import { useRecipe, useUpdateRecipe, useDeleteRecipe, useCreateRecipe } from "@/api/hooks";
import type { FoodItem, Recipe, RecipeIngredient, RecipeIngredientInput } from "@/api/types";
import { useTheme } from "@/theme";

// The blank manual editor (recipes.tsx's "New") is this same screen mounted
// with this sentinel id — a real recipe id never collides with it. Keeping
// create and edit on one screen avoids a third route for what is otherwise
// the identical form.
const NEW_RECIPE_ID = "new";

// Recipe.ingredients -> RecipeIngredientInput, for a save that must carry the
// ingredient list forward UNCHANGED (the servings stepper below). Only the
// fields SaveRecipeBody accepts survive the round-trip — resolved/kcal/
// protein_g/etc. are server-computed and never sent back.
function toIngredientInputs(ingredients: RecipeIngredient[]): RecipeIngredientInput[] {
  return ingredients.map((i) => ({
    food_item_id: i.food_item_id,
    raw_text: i.raw_text,
    grams: i.grams,
    entered_amount: i.entered_amount,
    entered_unit: i.entered_unit,
    portion_assumed: i.portion_assumed,
    match_score: i.match_score,
    match_tier: i.match_tier,
  }));
}

function macroStat(label: string, grams: number) {
  return <Stat label={label} value={String(Math.round(grams))} unit="g" />;
}

interface IngredientRowProps {
  ingredient: RecipeIngredient;
  onFindMatch: () => void;
}

// An unresolved ingredient contributes zero macros and must show the raw
// parsed text (never a food name it doesn't have) plus a way out. A
// portion_assumed ingredient is a real measurement's food but a GUESSED
// grams figure — issue #138's rule: that guess must never render as fact.
// Same "engraved, mut, no accent" treatment DetectedCard.tsx uses for the
// identical claim on the capture-review path, so the two surfaces agree.
function IngredientRow({ ingredient, onFindMatch }: IngredientRowProps) {
  const { instrument, spacing } = useTheme();
  const label = ingredient.resolved ? ingredient.name : ingredient.raw_text;
  return (
    <View style={{ paddingHorizontal: spacing.md, paddingVertical: 10, gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <AppText
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: "500",
            color: ingredient.resolved ? instrument.ink : instrument.mut,
            fontStyle: ingredient.resolved ? "normal" : "italic",
          }}
        >
          {label}
        </AppText>
        <AppText style={{ fontSize: 13, color: instrument.mut, fontVariant: ["tabular-nums"] }}>
          {Math.round(ingredient.grams)} g · {Math.round(ingredient.kcal)} kcal
        </AppText>
      </View>
      {ingredient.portion_assumed ? (
        <AppText
          style={{
            color: instrument.mut,
            fontSize: 9,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          portion is a guess
        </AppText>
      ) : null}
      {!ingredient.resolved ? (
        <PressableScale accessibilityRole="button" accessibilityLabel={`Find a match for ${ingredient.raw_text}`} haptic="selection" onPress={onFindMatch}>
          <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.accent, marginTop: 2 }}>
            Find a match
          </AppText>
        </PressableScale>
      ) : null}
    </View>
  );
}

function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (next: number) => void; min?: number }) {
  const { instrument } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Decrease servings"
        haptic="selection"
        onPress={() => onChange(Math.max(min, value - 1))}
        style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: instrument.inset, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="minus" size={16} color={instrument.accent} />
      </PressableScale>
      <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink, minWidth: 24, textAlign: "center" }}>
        {value}
      </AppText>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Increase servings"
        haptic="selection"
        onPress={() => onChange(value + 1)}
        style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: instrument.inset, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="plus" size={16} color={instrument.accent} />
      </PressableScale>
    </View>
  );
}

export default function RecipeDetail() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === NEW_RECIPE_ID;
  const detail = useRecipe(isNew ? "" : id);
  const updateRecipe = useUpdateRecipe();
  const deleteRecipe = useDeleteRecipe();
  const createRecipe = useCreateRecipe();
  const toast = useToast();

  const [matchTargetIndex, setMatchTargetIndex] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  // Manual-editor local state — only meaningful when isNew.
  const [draftName, setDraftName] = useState("");
  const [draftServings, setDraftServings] = useState(1);
  const [draftIngredients, setDraftIngredients] = useState<(RecipeIngredientInput & { name: string })[]>([]);
  const [draftAddOpen, setDraftAddOpen] = useState(false);

  const r = detail.data;

  const saveServings = (next: number) => {
    if (!r) return;
    updateRecipe.mutate(
      { id: r.id, body: { name: r.name, servings: next, source: r.source, ingredients: toIngredientInputs(r.ingredients) } },
      { onError: () => toast.show({ message: "Couldn't update servings. Try again." }) },
    );
  };

  const resolveIngredient = (index: number, item: FoodItem) => {
    if (!r) return;
    const ingredients = toIngredientInputs(r.ingredients).map((ing, i) =>
      i === index ? { ...ing, food_item_id: item.id } : ing,
    );
    updateRecipe.mutate(
      { id: r.id, body: { name: r.name, servings: r.servings, source: r.source, ingredients } },
      { onError: () => toast.show({ message: "Couldn't update that ingredient. Try again." }) },
    );
    setMatchTargetIndex(null);
  };

  const onDelete = () => {
    if (!r) return;
    Alert.alert("Delete this recipe?", "This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteRecipe.mutate(r.id, {
            onSuccess: () => router.back(),
            onError: () => toast.show({ message: "Couldn't delete that recipe. Try again." }),
          }),
      },
    ]);
  };

  const addDraftIngredient = (item: FoodItem) => {
    setDraftIngredients((prev) => [
      ...prev,
      {
        food_item_id: item.id,
        raw_text: item.name,
        name: item.name,
        grams: item.serving_grams || 100,
        entered_amount: null,
        entered_unit: null,
        portion_assumed: false,
        match_score: null,
        match_tier: null,
      },
    ]);
    setDraftAddOpen(false);
  };

  const removeDraftIngredient = (index: number) => {
    setDraftIngredients((prev) => prev.filter((_, i) => i !== index));
  };

  const saveDraft = () => {
    const name = draftName.trim();
    if (!name || draftIngredients.length === 0) return;
    createRecipe.mutate(
      {
        name,
        servings: draftServings,
        source: "manual",
        ingredients: draftIngredients.map(({ name: _name, ...rest }) => rest),
      },
      {
        onSuccess: (created: Recipe) => router.replace(`/recipe/${created.id}` as Href),
        onError: () => toast.show({ message: "Couldn't save that recipe. Try again." }),
      },
    );
  };

  if (isNew) {
    return (
      <>
        <View style={{ flex: 1, backgroundColor: instrument.bg }}>
          <AppBackground />
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
            <ScreenHeader overline="New recipe" title="New recipe" onBack={() => safeBack("/recipes" as Href)} />
            <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                autoCapitalize="sentences"
                placeholder="Recipe name"
                placeholderTextColor={instrument.mut}
                accessibilityLabel="Recipe name"
                style={{ fontSize: 16, color: instrument.ink, backgroundColor: instrument.inset, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12 }}
              />

              <View style={{ gap: spacing.xs }}>
                <Overline>Servings</Overline>
                <Stepper value={draftServings} onChange={setDraftServings} />
              </View>

              <View style={{ gap: spacing.xs }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Overline>Ingredients</Overline>
                  <PressableScale accessibilityRole="button" accessibilityLabel="Add ingredient" haptic="selection" onPress={() => setDraftAddOpen(true)}>
                    <AppText style={{ color: instrument.accent, fontWeight: "600" }}>+ Add</AppText>
                  </PressableScale>
                </View>
                {draftIngredients.length === 0 ? (
                  <AppText muted>No ingredients yet.</AppText>
                ) : (
                  <GroupedSection>
                    {draftIngredients.map((ing, index) => (
                      <Row
                        key={`${ing.food_item_id}-${index}`}
                        title={ing.name}
                        subtitle={`${Math.round(ing.grams)} g`}
                        right={
                          <PressableScale
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${ing.name}`}
                            haptic="none"
                            onPress={() => removeDraftIngredient(index)}
                          >
                            <Icon name="trash-2" size={16} color={instrument.danger} />
                          </PressableScale>
                        }
                      />
                    ))}
                  </GroupedSection>
                )}
              </View>

              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Save recipe"
                haptic="impactLight"
                disabled={!draftName.trim() || draftIngredients.length === 0 || createRecipe.isPending}
                onPress={saveDraft}
                style={{
                  minHeight: 50,
                  borderRadius: 12,
                  backgroundColor: instrument.accent,
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: !draftName.trim() || draftIngredients.length === 0 || createRecipe.isPending ? 0.5 : 1,
                }}
              >
                <AppText style={{ color: instrument.accentOn, fontWeight: "700", fontSize: 17 }}>
                  {createRecipe.isPending ? "Saving…" : "Save recipe"}
                </AppText>
              </PressableScale>
            </View>
          </ScrollView>
        </View>
        <FoodPicker visible={draftAddOpen} initialQuery="" title="Add ingredient" onSelect={addDraftIngredient} onClose={() => setDraftAddOpen(false)} />
      </>
    );
  }

  return (
    <>
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
          <ScreenHeader overline="Recipe" title={r?.name ?? "Recipe"} onBack={() => safeBack("/recipes" as Href)} />

          {r ? (
            <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
              {r.unresolved_count > 0 ? (
                <AppText style={{ fontSize: 13, color: instrument.mut, fontWeight: "600" }}>
                  {r.unresolved_count} ingredient{r.unresolved_count === 1 ? "" : "s"} unresolved — totals below are partial.
                </AppText>
              ) : null}

              <View style={{ gap: spacing.sm }}>
                <Overline>Per serving</Overline>
                <Card variant="elevated" style={{ flexDirection: "row" }}>
                  <View style={{ flex: 1 }}>{macroStat("Kcal", r.per_serving_kcal)}</View>
                  <View style={{ flex: 1 }}>{macroStat("Protein", r.per_serving_protein_g)}</View>
                  <View style={{ flex: 1 }}>{macroStat("Carbs", r.per_serving_carbs_g)}</View>
                  <View style={{ flex: 1 }}>{macroStat("Fat", r.per_serving_fat_g)}</View>
                </Card>
              </View>

              <View style={{ gap: spacing.xs }}>
                <Overline>Whole recipe</Overline>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>
                  {Math.round(r.total_kcal)} kcal · {Math.round(r.total_protein_g)}g protein · {Math.round(r.total_carbs_g)}g carbs · {Math.round(r.total_fat_g)}g fat
                </AppText>
              </View>

              <View style={{ gap: spacing.xs }}>
                <Overline>Servings</Overline>
                <Stepper value={r.servings} onChange={saveServings} />
              </View>

              <View style={{ gap: spacing.xs }}>
                <Overline>Ingredients</Overline>
                <GroupedSection>
                  {r.ingredients.map((ing, index) => (
                    <IngredientRow key={index} ingredient={ing} onFindMatch={() => setMatchTargetIndex(index)} />
                  ))}
                </GroupedSection>
              </View>

              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Log this recipe"
                haptic="impactLight"
                onPress={() => setLogOpen(true)}
                style={{ minHeight: 50, borderRadius: 12, backgroundColor: instrument.accent, alignItems: "center", justifyContent: "center" }}
              >
                <AppText style={{ color: instrument.accentOn, fontWeight: "700", fontSize: 17 }}>Log</AppText>
              </PressableScale>

              <GroupedSection>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Delete recipe"
                  haptic="none"
                  disabled={deleteRecipe.isPending}
                  onPress={onDelete}
                  style={{ opacity: deleteRecipe.isPending ? 0.5 : 1 }}
                >
                  <View style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md }}>
                    <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.danger }}>Delete recipe</AppText>
                  </View>
                </PressableScale>
              </GroupedSection>
            </View>
          ) : detail.isError ? (
            <View style={{ paddingHorizontal: 20 }}>
              <AppText muted>Couldn't load this recipe.</AppText>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 20 }}>
              <AppText muted>Loading…</AppText>
            </View>
          )}
        </ScrollView>
      </View>

      {r ? (
        <FoodPicker
          visible={matchTargetIndex !== null}
          initialQuery={matchTargetIndex !== null ? r.ingredients[matchTargetIndex].raw_text : ""}
          title="Find a match"
          onSelect={(item) => {
            if (matchTargetIndex !== null) resolveIngredient(matchTargetIndex, item);
          }}
          onClose={() => setMatchTargetIndex(null)}
        />
      ) : null}

      {r ? <LogRecipeSheet visible={logOpen} recipeId={r.id} defaultServings={r.servings} onClose={() => setLogOpen(false)} /> : null}
    </>
  );
}
