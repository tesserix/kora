import { Pressable } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { haptics } from "@/motion";
import { captureColors } from "./captureTheme";

interface Props {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
}

// One of the four input-mode chips in the composer bar (Photo/Voice/Scan/Type),
// also reused for the DetectedCard meal-slot chips — a dark, Segmented-style
// treatment: a `pillBg` (cardSecondary) track holding a green-filled active chip.
export function ModePill({ icon, label, active, onPress }: Props) {
  const fg = active ? captureColors.primaryForeground : captureColors.pillFg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 9999,
        backgroundColor: active ? captureColors.primary : captureColors.pillBg,
        opacity: state.pressed ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={14} color={fg} />
      <AppText style={{ color: fg, fontSize: 12, fontWeight: "600" }}>{label}</AppText>
    </Pressable>
  );
}
