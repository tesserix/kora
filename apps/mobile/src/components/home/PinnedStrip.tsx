import { View } from "react-native";
import { AppText } from "@/components/Text";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { MealRow } from "@/components/MealRow";
import { useTheme } from "@/theme";
import { usePins } from "@/api/hooks";
import { usePinToggle } from "@/api/usePinToggle";
import { useInstantLog } from "@/api/useInstantLog";
import { formatPortion } from "@/units/portion";
import { foodVisual } from "@/lib/foodVisual";
import { hslToHex } from "@/lib/color";

// PinnedStrip surfaces the user's pinned foods on Home for one-tap logging.
// Renders nothing while loading/error/empty. Instrument Glass (I1): a
// sentence-case muted caption over a single GlassPanel, replacing the legacy
// Overline + GroupedSection — pure restyle, props/behavior unchanged.
export function PinnedStrip() {
  const { instrument } = useTheme();
  const pins = usePins();
  const { toggle } = usePinToggle();
  const { logFood } = useInstantLog();

  if (pins.isLoading || pins.isError) return null;
  const data = pins.data ?? [];
  if (data.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 16, marginTop: 8 }}>
      <AppText style={{ fontSize: 11, color: instrument.mut, marginBottom: 8 }}>Pinned</AppText>
      <GlassPanel radius={20}>
        {data.map((f) => {
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
      </GlassPanel>
    </View>
  );
}
