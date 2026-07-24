import { Pressable } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { captureColors } from "./captureTheme";

type Props = {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
};

// One of the four input-mode chips in the composer bar (Photo/Voice/Scan/Type).
export function ModePill({ icon, label, active, onPress }: Props) {
  const fg = active ? captureColors.primaryForeground : captureColors.pillFg;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
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
