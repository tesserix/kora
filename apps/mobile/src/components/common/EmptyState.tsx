import { View, TextStyle, ViewStyle } from "react-native";
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
  // Optional: a screen whose own controls already carry the glyph omits the tile.
  icon?: string;
  title: string;
  subtitle: string;
  cta?: EmptyStateCta;
  // Optional instrument-glass styling overrides (defaults to legacy palette)
  variant?: "instrument";
}

// EmptyState is a presentational first-run/cold-start block: a soft accent-tinted
// circular icon tile, a serif-ish title, a muted subtitle, and an optional CTA.
// All copy is supplied by props — no hard-coded strings live here.
//
// The `variant="instrument"` option overrides colors for instrument-glass panels:
// icon tile becomes inset with glassBorder, text becomes ink/mut, CTA becomes
// accent pill (weight 700, radius 22).
export function EmptyState({ icon, title, subtitle, cta, variant }: EmptyStateProps) {
  const { colors, spacing, radius, instrument } = useTheme();

  const isInstrument = variant === "instrument";

  // Instrument variant: 64pt circle (vs legacy 72pt)
  const iconSize = isInstrument ? 64 : 72;
  const iconInnerSize = isInstrument ? 24 : 30;

  // Icon tile styling
  const iconTileBg = isInstrument
    ? instrument.inset
    : withAlpha(colors.accent, 0.12);
  const iconColor = isInstrument ? instrument.mut : colors.accent;
  const iconTileBorderColor = isInstrument ? instrument.glassBorder : undefined;
  const iconTileBorderWidth = isInstrument ? 1 : undefined;

  // Text styling
  const titleColor: TextStyle["color"] = isInstrument ? instrument.ink : undefined;
  const titleFontWeight: TextStyle["fontWeight"] = isInstrument ? "600" : undefined;
  const subtitleColor: TextStyle["color"] = isInstrument ? instrument.mut : undefined;

  // CTA styling
  const ctaBg = isInstrument ? instrument.accent : colors.accent;
  const ctaText = isInstrument ? instrument.accentOn : colors.accentForeground;
  const ctaWeight: TextStyle["fontWeight"] = isInstrument ? "700" : undefined;
  const ctaRadius = isInstrument ? 22 : radius.full;

  return (
    <View style={{ alignItems: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xl, gap: spacing.md }}>
      {icon ? (
      <View
        testID="empty-state-icon"
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: iconTileBg,
          ...(iconTileBorderWidth && { borderWidth: iconTileBorderWidth, borderColor: iconTileBorderColor }),
        } as ViewStyle}
      >
        <Icon name={icon} size={iconInnerSize} color={iconColor} />
      </View>
      ) : null}
      <View style={{ alignItems: "center", gap: spacing.xs }}>
        <AppText
          variant="title2"
          style={[
            { textAlign: "center" },
            titleColor && { color: titleColor },
            titleFontWeight && { fontWeight: titleFontWeight },
          ]}
        >
          {title}
        </AppText>
        <AppText
          variant="subheadline"
          muted={!isInstrument}
          style={[
            { textAlign: "center" },
            subtitleColor && { color: subtitleColor },
          ]}
        >
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
            borderRadius: ctaRadius,
            backgroundColor: ctaBg,
          }}
        >
          <AppText
            variant="headline"
            style={[
              { color: ctaText },
              ctaWeight && { fontWeight: ctaWeight },
            ]}
          >
            {cta.label}
          </AppText>
        </PressableScale>
      ) : null}
    </View>
  );
}

export type { EmptyStateProps, EmptyStateCta };
