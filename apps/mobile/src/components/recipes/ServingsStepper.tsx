import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

interface ServingsStepperProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
}

// A plain integer +/- control for a recipe's servings count. Deliberately NOT
// `src/components/Stepper.tsx` — that component is grams-specific (renders
// "{value} g", step=10, press-and-hold repeat, legacy `colors` theme) and
// reusing it here would either lie about the unit or require fighting its
// grams-only API. This one is shared by the two places a recipe's servings
// count is edited: the detail screen's own stepper and LogRecipeSheet's
// per-log servings picker (previously two copies of the same markup).
export function ServingsStepper({ value, onChange, min = 1 }: ServingsStepperProps) {
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
