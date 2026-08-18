import { StyleSheet, View } from "react-native";
import type { CoachNudge } from "@/api/types";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export function CoachEntryCard({ nudge, onPress }: { nudge: CoachNudge | undefined; onPress: () => void }) {
  const { instrument, spacing } = useTheme();
  const overline = nudge ? "Otto · today’s focus" : "Otto · coach";
  const summary = nudge ? `${nudge.title}: ${nudge.text}` : "Ask Otto about your nutrition";
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={nudge ? `Open coach. ${summary}` : "Open coach"}
      haptic="selection"
      onPress={onPress}
      style={{
        minHeight: 64,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingVertical: 10,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.hairline,
      }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: instrument.inset }}>
        <Icon name="message-circle" size={18} color={instrument.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={{ color: instrument.mut, fontSize: 11 }}>{overline}</AppText>
        <AppText numberOfLines={1} style={{ color: instrument.ink, fontSize: 14, fontWeight: "600", marginTop: 2 }}>
          {summary}
        </AppText>
      </View>
      <Icon name="chevron-right" size={15} color={instrument.mut} />
    </PressableScale>
  );
}
