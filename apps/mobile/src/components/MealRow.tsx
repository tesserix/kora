import { View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { name: string; slot: string; kcal: number; iconName?: string; tint?: string; onPress?: () => void; accessibilityLabel?: string };

export function MealRow({ name, slot, kcal, iconName = "utensils", tint, onPress, accessibilityLabel }: Props) {
  const { colors, radius, spacing } = useTheme();
  const chip = tint ?? colors.accent;
  return (
    <PressableScale testID="meal-row" accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? name} haptic="selection" onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: spacing.md }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(chip, 0.16) }}>
        <Icon name={iconName} size={18} color={chip} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="headline">{name}</AppText>
        <AppText variant="footnote" muted>{slot}</AppText>
      </View>
      <Numeral size={17}>{`${Math.round(kcal)} kcal`}</Numeral>
    </PressableScale>
  );
}
