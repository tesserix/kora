import { View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

interface LoadErrorNoticeProps {
  message: string;
  onRetry?: () => void;
  testID?: string;
}

// The counterpart to EmptyState, and deliberately never mistakable for it:
// "we couldn't load this" must never look like "you have none". A screen that
// falls through to its empty state on a failed fetch tells a user with a full
// diary that the day is blank.
//
// Ported from the banner Home ((tabs)/index.tsx) has always had — destructive
// copy, and the figures it covers hidden rather than zeroed — with a Retry
// action for the screens that have no pull-to-refresh to point at.
export function LoadErrorNotice({ message, onRetry, testID }: LoadErrorNoticeProps) {
  const { colors, spacing } = useTheme();

  return (
    <View
      testID={testID}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingVertical: spacing.sm }}
    >
      <AppText variant="subheadline" style={{ flex: 1, color: colors.destructive }}>
        {message}
      </AppText>
      {onRetry ? (
        <PressableScale accessibilityRole="button" accessibilityLabel="Retry" haptic="selection" onPress={onRetry}>
          <AppText variant="subheadline" style={{ fontWeight: "700", color: colors.destructive }}>
            Retry
          </AppText>
        </PressableScale>
      ) : null}
    </View>
  );
}

export type { LoadErrorNoticeProps };
