import { StyleSheet, View } from "react-native";
import type { CoachNudge } from "@/api/types";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { engravedStyle } from "@/components/instrument/typography";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export function CoachEntryCard({ nudge, onPress }: { nudge: CoachNudge | undefined; onPress: () => void }) {
  const { instrument, spacing } = useTheme();
  // Constant in both states (kora#313). This read "Otto · today's focus" when a
  // nudge existed and "Otto · coach" when none did — so the only word that says
  // what the row IS appeared solely in the empty state, and vanished the moment
  // the feature had something to show. The row is a doorway to the coach; the
  // nudge is what is behind the door, not what the door is called.
  //
  // "COACH" leads because it is the identifying word, and it matches the
  // destination's own title (app/coach.tsx's ScreenHeader) so tapping confirms
  // rather than surprises. "OTTO" follows as the persona the rest of the app
  // already uses ("Tell Otto what you ate").
  const overline = "Coach · Otto";
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
        {/* Not message-circle (kora#313): the diary uses that exact glyph for a
            TYPED CAPTURE, so it read as "a message" rather than "an assistant".
            sparkles is already in the icon set and is not spoken for. */}
        <Icon name="sparkles" size={18} color={instrument.accent} />
      </View>
      <View style={{ flex: 1 }}>
        {/* Engraved, like Home's sibling section labels (ENERGY RESERVE,
            MACROS): a constant name is a section header, not body text. */}
        <AppText style={engravedStyle(instrument)}>{overline}</AppText>
        {/* Two lines (kora#313): this is `${title}: ${text}`, and one line cut
            it mid-title — you saw the start of a claim and never the payoff.
            The overline carries identity now, so the body only carries content. */}
        <AppText numberOfLines={2} style={{ color: instrument.ink, fontSize: 14, fontWeight: "600", marginTop: 2 }}>
          {summary}
        </AppText>
      </View>
      <Icon name="chevron-right" size={15} color={instrument.mut} />
    </PressableScale>
  );
}
