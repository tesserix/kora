import { View } from "react-native";
import { AppText } from "@/components/Text";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { MealRow } from "@/components/MealRow";
import { useTheme } from "@/theme";
import { useSavedMeals } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// SavedMealsStrip surfaces the user's saved meals on Home for one-tap logging.
// Renders nothing while loading/error/empty. Instrument Glass (I1): a
// sentence-case muted caption over a single GlassPanel, replacing the legacy
// Overline + GroupedSection — pure restyle, props/behavior unchanged.
export function SavedMealsStrip() {
  const { instrument } = useTheme();
  const saved = useSavedMeals();
  const { logMeal } = useInstantLog();
  const { openEdit } = useSavedMealEditor();

  if (saved.isLoading || saved.isError) return null;
  const data = saved.data ?? [];
  if (data.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <AppText style={{ fontSize: 11, color: instrument.mut, marginBottom: 8 }}>Saved</AppText>
      <GlassPanel radius={20}>
        {data.map((m) => {
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
      </GlassPanel>
    </View>
  );
}
