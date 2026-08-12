import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GroupedSection, Row } from "@/components/GroupedList";
import { EmptyState } from "@/components/common/EmptyState";
import { PressableScale } from "@/motion";
import { useRecipes } from "@/api/hooks";
import type { Recipe } from "@/api/types";
import { useTheme } from "@/theme";

// A muted "N need attention" note, same treatment as groups.tsx's OwnerChip:
// styled inline rather than through Badge, because this is information (some
// ingredients didn't resolve, so the totals shown are partial), not a status
// the accent-reserved Badge variants are meant for. Never omit this when
// unresolved_count > 0 — the row's kcal figure is the total for what DID
// resolve, and without this note it reads as complete.
function AttentionNote({ count }: { count: number }) {
  const { instrument } = useTheme();
  return (
    <AppText style={{ fontSize: 12, color: instrument.mut, fontWeight: "600", marginLeft: 8 }}>
      {count} need{count === 1 ? "s" : ""} attention
    </AppText>
  );
}

// Header action for "Paste"/"Photo": stubs only. Task 9 wires these to the
// parse-review sheet (POST /v1/recipes/parse via useParseRecipe, then a
// review UI over the returned RecipeDraft before useCreateRecipe saves it).
// Until that sheet exists, tapping either does nothing — deliberately no
// dead navigation to a route that isn't built yet.
function HeaderAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { instrument } = useTheme();
  return (
    <PressableScale accessibilityRole="button" accessibilityLabel={label} haptic="selection" onPress={onPress}>
      <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.accent }}>{label}</AppText>
    </PressableScale>
  );
}

export default function Recipes() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const recipes = useRecipes();
  const list: Recipe[] = recipes.data ?? [];

  // Task 9 connects these to the parse-review sheet — see HeaderAction's
  // comment. "New" needs no such wiring: the blank manual editor is the
  // detail/editor screen itself, opened with the sentinel id "new".
  const onPaste = () => {};
  const onPhoto = () => {};

  const headerActions = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <HeaderAction label="Paste" onPress={onPaste} />
      <HeaderAction label="Photo" onPress={onPhoto} />
      <HeaderAction label="New" onPress={() => router.push("/recipe/new" as Href)} />
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Your recipes" title="Recipes" onBack={() => safeBack("/(tabs)/more")} right={headerActions} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {recipes.isLoading ? (
            <AppText muted>Loading…</AppText>
          ) : recipes.isError ? (
            <AppText muted>Couldn't load your recipes.</AppText>
          ) : list.length === 0 ? (
            <EmptyState
              variant="instrument"
              icon="book-open"
              title="No recipes yet"
              subtitle="Paste or photograph a recipe to reuse it."
            />
          ) : (
            <GroupedSection>
              {list.map((r) => (
                <Row
                  key={r.id}
                  title={r.name}
                  subtitle={`makes ${r.servings}`}
                  detail={`${Math.round(r.per_serving_kcal)} kcal`}
                  chevron
                  onPress={() => router.push(`/recipe/${r.id}` as Href)}
                  right={r.unresolved_count > 0 ? <AttentionNote count={r.unresolved_count} /> : undefined}
                />
              ))}
            </GroupedSection>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
