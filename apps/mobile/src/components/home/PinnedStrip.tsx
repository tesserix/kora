import { View } from "react-native";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { usePins } from "@/api/hooks";
import { usePinToggle } from "@/api/usePinToggle";
import { useInstantLog } from "@/api/useInstantLog";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// PinnedStrip surfaces the user's pinned foods on Home for one-tap logging.
// Renders nothing while loading/error/empty.
export function PinnedStrip() {
  const pins = usePins();
  const { toggle } = usePinToggle();
  const { logFood } = useInstantLog();

  if (pins.isLoading || pins.isError) return null;
  const data = pins.data ?? [];
  if (data.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <Overline style={{ marginBottom: 8 }}>Pinned</Overline>
      <GroupedSection elevated>
        {data.map((f) => {
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
    </View>
  );
}
