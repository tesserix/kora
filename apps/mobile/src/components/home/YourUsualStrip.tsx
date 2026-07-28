import { View } from "react-native";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { useMemory } from "@/api/hooks";
import { useInstantLog } from "@/api/useInstantLog";
import { yourUsual } from "@/lib/yourUsual";
import { mealSlotForHour } from "@/lib/mealSlot";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// Same local-date convention as app/log.tsx so the ["memory", date] query is
// cache-shared between Home and the Log screen.
function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

// YourUsualStrip: a contextual "one-tap log" section on Home showing the user's
// usual meals/foods for the current meal slot. Renders nothing while loading,
// on error, or when there is nothing to show (keeps Home uncluttered for new
// users and off-hours).
export function YourUsualStrip() {
  const memory = useMemory(today());
  const { logFood, logMeal } = useInstantLog();
  const slot = mealSlotForHour(new Date().getHours());
  const rows = yourUsual(memory.data, slot);

  if (memory.isLoading || memory.isError || rows.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <Overline style={{ marginBottom: 8 }}>{`Your usual ${slot}`}</Overline>
      <GroupedSection elevated>
        {rows.map((row) => {
          if (row.kind === "meal") {
            const m = row.meal;
            const fv = foodVisual(m.name);
            return (
              <MealRow
                key={`meal-${m.id}`}
                name={m.name}
                slot={m.items.map((i) => i.name).join(" · ")}
                kcal={m.kcal}
                iconName={fv.icon}
                tint={hslToHex(fv.hue, 0.5, 0.5)}
                onPress={() => logMeal(m)}
                accessibilityLabel={m.name}
              />
            );
          }
          const f = row.food;
          const fv = foodVisual(f.name);
          return (
            <MealRow
              key={`food-${f.food_item_id}`}
              name={f.name}
              slot={`${Math.round(f.grams)}g`}
              kcal={f.kcal}
              iconName={fv.icon}
              tint={hslToHex(fv.hue, 0.5, 0.5)}
              onPress={() => logFood(f)}
              accessibilityLabel={f.name}
            />
          );
        })}
      </GroupedSection>
    </View>
  );
}
