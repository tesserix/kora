import { Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
}

export function Stepper({ value, onChange, step = 10, min = 0 }: StepperProps) {
  const { colors, radius, fonts } = useTheme();
  const btn = {
    width: 30,
    height: 30,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Decrease" onPress={() => onChange(Math.max(min, value - step))} style={btn}>
        <Icon name="minus" size={14} color={colors.foreground} />
      </Pressable>
      <AppText style={{ minWidth: 56, textAlign: "center", fontFamily: fonts.mono, fontSize: 15, fontWeight: "600" }}>{value} g</AppText>
      <Pressable accessibilityRole="button" accessibilityLabel="Increase" onPress={() => onChange(value + step)} style={btn}>
        <Icon name="plus" size={14} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
