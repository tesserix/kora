import { StyleSheet, View } from "react-native";
import type { CoachDietFlag } from "@/api/types";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

// DietFlagNotice says which of the user's preferences an answer touched.
//
// It is a note, not a warning: a preference the coach worked around silently
// would leave the user unable to tell whether Kora remembered it at all, and
// suppressing an otherwise good answer over one would be worse than saying so.
// Allergies never reach here — those are enforced before the answer is shown.
export function DietFlagNotice({ flags }: { flags: CoachDietFlag[] }) {
  const { instrument, spacing } = useTheme();
  if (flags.length === 0) return null;

  const labels = flags.map((flag) => flag.label.toLowerCase());
  const named = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  return (
    <View
      testID="coach-diet-flags"
      accessible
      accessibilityLabel={`This answer mentions ${named}, which you prefer to avoid.`}
      style={{
        marginBottom: 12,
        padding: spacing.md,
        borderRadius: 14,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
        flexDirection: "row",
        gap: spacing.sm,
      }}
    >
      <Icon name="leaf" size={18} color={instrument.mut} />
      <AppText style={{ color: instrument.mut, fontSize: 13, lineHeight: 19, flex: 1 }}>
        This mentions {named}, which you prefer to avoid. Your call.
      </AppText>
    </View>
  );
}
