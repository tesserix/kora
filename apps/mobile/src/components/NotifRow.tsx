import { StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = { type: string; iconName: string; tint: string; text: string; time: string; unread: boolean; onPress?: () => void };

// Restyled to Instrument Glass: the icon tile drops its per-type tinted
// background for the shared inset+glassBorder+mut recipe (spec:
// NotifRow.tsx > "instrument tokens; any green/legacy accent → ink/mut").
// `tint` is kept on the prop type for call-site compatibility but is no
// longer used to color the tile. The unread indicator is the one accent
// element this row is allowed, shrunk to the spec's 4pt accent-dot budget.
export function NotifRow({ iconName, text, time, unread, onPress }: Props) {
  const { instrument, spacing } = useTheme();
  return (
    <PressableScale testID="notif-row" accessibilityRole={onPress ? "button" : undefined} haptic={onPress ? "selection" : "none"} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: spacing.md }}>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: instrument.inset,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: instrument.glassBorder,
        }}
      >
        <Icon name={iconName} size={17} color={instrument.mut} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 15, color: instrument.ink }}>{text}</AppText>
        <AppText style={{ fontSize: 12, color: instrument.mut, marginTop: 2 }}>{time}</AppText>
      </View>
      {unread ? (
        <View testID="notif-unread-dot" style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: instrument.accent }} />
      ) : null}
    </PressableScale>
  );
}
