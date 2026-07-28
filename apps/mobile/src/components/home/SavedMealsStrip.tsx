import { View } from "react-native";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { useSavedMeals } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// SavedMealsStrip surfaces the user's saved meals on Home for one-tap logging.
// Renders nothing while loading/error/empty.
export function SavedMealsStrip() {
  const saved = useSavedMeals();
  const { logMeal } = useInstantLog();
  const { openEdit } = useSavedMealEditor();

  if (saved.isLoading || saved.isError) return null;
  const data = saved.data ?? [];
  if (data.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <Overline style={{ marginBottom: 8 }}>Saved</Overline>
      <GroupedSection elevated>
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
      </GroupedSection>
    </View>
  );
}
