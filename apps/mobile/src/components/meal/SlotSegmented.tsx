import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import type { MealSlot } from "@/lib/mealSlot";

export const SLOT_OPTIONS: Array<{ key: MealSlot; label: string }> = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];

export interface SlotSegmentedProps {
  value: MealSlot;
  onChange: (key: MealSlot) => void;
}

// Instrument-glass meal-slot control for app/meal.tsx — same
// track/inset/glassBorder pattern as progress.tsx's RangeSegmented, kept
// meal-specific since its options (the four meal slots) are specific to
// this screen.
export function SlotSegmented({ value, onChange }: SlotSegmentedProps) {
  const { instrument } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: instrument.glass,
        borderRadius: 12,
        padding: 3,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
      }}
    >
      {SLOT_OPTIONS.map((opt) => {
        const selected = opt.key === value;
        return (
          <PressableScale
            key={opt.key}
            accessibilityRole="tab"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected }}
            haptic="selection"
            onPress={() => onChange(opt.key)}
            style={{
              flex: 1,
              paddingVertical: 8,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? instrument.inset : "transparent",
              borderWidth: selected ? StyleSheet.hairlineWidth : 0,
              borderColor: instrument.glassBorder,
            }}
          >
            <AppText style={{ fontSize: 12, fontWeight: "600", color: selected ? instrument.ink : instrument.mut }}>
              {opt.label}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}
