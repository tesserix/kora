import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

interface EmptyStateCta {
  label: string;
  onPress: () => void;
}

interface EmptyStateProps {
  icon: string;
  title: string;
  subtitle: string;
  cta?: EmptyStateCta;
}

// EmptyState is a presentational first-run/cold-start block: a soft accent-tinted
// circular icon tile, a serif-ish title, a muted subtitle, and an optional CTA.
// All copy is supplied by props — no hard-coded strings live here.
export function EmptyState({ icon, title, subtitle, cta }: EmptyStateProps) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, gap: spacing.md }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: withAlpha(colors.accent, 0.12),
        }}
      >
        <Icon name={icon} size={30} color={colors.accent} />
      </View>
      <View style={{ alignItems: "center", gap: spacing.xs }}>
        <AppText variant="title2" style={{ textAlign: "center" }}>
          {title}
        </AppText>
        <AppText variant="subheadline" muted style={{ textAlign: "center" }}>
          {subtitle}
        </AppText>
      </View>
      {cta ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={cta.label}
          haptic="selection"
          onPress={cta.onPress}
          style={{
            marginTop: spacing.xs,
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.lg,
            borderRadius: radius.full,
            backgroundColor: colors.accent,
          }}
        >
          <AppText variant="headline" style={{ color: colors.accentForeground }}>
            {cta.label}
          </AppText>
        </PressableScale>
      ) : null}
    </View>
  );
}

export type { EmptyStateProps, EmptyStateCta };
