import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = { type: string; iconName: string; tint: string; text: string; time: string; unread: boolean; onPress?: () => void };

export function NotifRow({ iconName, tint, text, time, unread, onPress }: Props) {
  const { colors, radius, spacing } = useTheme();
  return (
    <PressableScale testID="notif-row" accessibilityRole="button" haptic="selection" onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: spacing.md }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(tint, 0.16) }}>
        <Icon name={iconName} size={18} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="subheadline">{text}</AppText>
        <AppText variant="caption" muted>{time}</AppText>
      </View>
      {unread ? <View testID="notif-unread-dot" style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: colors.accent }} /> : null}
    </PressableScale>
  );
}
