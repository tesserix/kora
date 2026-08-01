import { View } from "react-native";
import { AppText } from "./Text";
import { Button } from "./Button";
import { useTheme } from "@/theme";
import type { ActivityInference } from "@/health/inferActivity";
import type { ActivityHistoryStatus } from "@/health/useActivityHistory";

type Props = {
  status: ActivityHistoryStatus;
  inference: ActivityInference | null;
  levelLabel: (level: ActivityInference["level"]) => string;
  onUseHealth: () => void;
  onAccept: (level: ActivityInference["level"]) => void;
};

// Copy for the states where nothing can be inferred. Each says what actually
// happened rather than a single vague failure, and each leaves the manual card
// list below as the way forward — never a guessed level.
const FALLBACK_COPY: Partial<Record<ActivityHistoryStatus, string>> = {
  denied: "No problem — Kora can't see your Health data. Pick a level below.",
  unavailable: "Health data isn't available on this device. Pick a level below.",
  insufficient: "There isn't enough recent activity yet to tell. Pick a level below.",
};

/**
 * Opt-in Health-based suggestion for the activity question. Renders above the
 * manual card list, which always remains the fallback: the suggestion is offered
 * and confirmed, never silently applied.
 */
export function ActivityFromHealth({
  status,
  inference,
  levelLabel,
  onUseHealth,
  onAccept,
}: Props) {
  const { colors, radius, spacing } = useTheme();

  if (status === "idle") {
    return (
      <Button
        title="Use my Health data"
        variant="secondary"
        icon="heart"
        onPress={onUseHealth}
      />
    );
  }

  if (status === "loading") {
    return <Button title="Reading Health data…" variant="secondary" disabled onPress={() => {}} />;
  }

  if (status === "ready" && inference) {
    return (
      <View
        accessibilityLiveRegion="polite"
        style={{
          padding: spacing.md,
          borderRadius: radius.xl,
          backgroundColor: colors.card,
          borderWidth: 2,
          borderColor: colors.primary,
          gap: spacing.sm,
        }}
      >
        <AppText variant="footnote" muted>
          {inference.reason}
        </AppText>
        <AppText variant="headline">That reads as {levelLabel(inference.level)}.</AppText>
        <Button
          title="Sounds right"
          icon="check"
          onPress={() => onAccept(inference.level)}
        />
      </View>
    );
  }

  const copy = FALLBACK_COPY[status];
  return copy ? (
    <AppText variant="footnote" muted accessibilityLiveRegion="polite">
      {copy}
    </AppText>
  ) : null;
}
