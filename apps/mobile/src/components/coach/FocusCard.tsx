import { StyleSheet, View } from "react-native";
import type { CoachNudge } from "@/api/types";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { nudgeVisual } from "./nudgeVisual";

export function FocusCard({ nudge, last = false }: { nudge: CoachNudge; last?: boolean }) {
  const { instrument, spacing } = useTheme();
  const visual = nudgeVisual(nudge.kind);
  const iconColor = visual.tone === "accent" ? instrument.accent : visual.tone === "status" ? instrument.teal : instrument.mut;

  return (
    <View style={{ flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: 14 }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          backgroundColor: instrument.inset,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: instrument.glassBorder,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={visual.icon} size={19} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={{ color: instrument.ink, fontSize: 15, fontWeight: "700" }}>{nudge.title}</AppText>
        <AppText style={{ color: instrument.mut, fontSize: 13, lineHeight: 19, marginTop: 2 }}>{nudge.text}</AppText>
      </View>
      {!last ? (
        <View
          style={{
            position: "absolute",
            left: spacing.md + 40 + spacing.md,
            right: spacing.md,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: instrument.hairline,
          }}
        />
      ) : null}
    </View>
  );
}
