import { Children, type ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { GlassPanel } from "./instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type GroupedSectionProps = {
  header?: string;
  footer?: string;
  children: ReactNode;
  style?: ViewStyle;
  // Retained for call-site compatibility during the Instrument Glass
  // migration — every section now renders on a GlassPanel regardless of this
  // flag, since GlassPanel already carries its own elevation (blur + border +
  // shadow). See docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md.
  elevated?: boolean;
};

// iOS grouped-table-view section, restyled to Instrument Glass: an uppercase
// caption header, a GlassPanel (radius 22) of rows with hairline separators
// auto-inserted between them (none before the first / after the last), and
// an optional footnote footer.
export function GroupedSection({ header, footer, children, style }: GroupedSectionProps) {
  const { instrument, spacing } = useTheme();
  const rows = Children.toArray(children).filter(Boolean);

  return (
    <View style={style}>
      {header ? (
        <AppText
          style={{
            marginLeft: spacing.md,
            marginBottom: spacing.xs,
            textTransform: "uppercase",
            fontSize: 11,
            letterSpacing: 0.5,
            fontWeight: "500",
            color: instrument.mut,
          }}
        >
          {header}
        </AppText>
      ) : null}
      <GlassPanel radius={22}>
        {rows.map((row, index) => (
          <View key={index}>
            {row}
            {index < rows.length - 1 ? (
              <View
                testID="row-sep"
                style={{
                  marginLeft: spacing.md,
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: instrument.hairline,
                }}
              />
            ) : null}
          </View>
        ))}
      </GlassPanel>
      {footer ? (
        <AppText style={{ marginTop: spacing.xs, marginLeft: spacing.md, fontSize: 13, color: instrument.mut }}>
          {footer}
        </AppText>
      ) : null}
    </View>
  );
}

type RowIcon = { name: string; tint: string };

type RowProps = {
  title: string;
  subtitle?: string;
  detail?: string;
  icon?: RowIcon;
  chevron?: boolean;
  destructive?: boolean;
  onPress?: () => void;
  right?: ReactNode;
  accessibilityLabel?: string;
};

// A single grouped-list row: 44pt min height, optional inset+glassBorder icon
// tile (mut glyph, same recipe as more.tsx's MoreRow), title/subtitle stack,
// right-aligned detail, optional chevron. Interactive rows (onPress given)
// use PressableScale; static rows render a plain View. `icon.tint` is kept on
// the prop type for call-site compatibility but is no longer used for
// color — Instrument Glass icon tiles are always `mut` (spec: GroupedList
// section of the More-subscreens uplift).
export function Row({ title, subtitle, detail, icon, chevron, destructive, onPress, right, accessibilityLabel }: RowProps) {
  const { instrument, spacing } = useTheme();

  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md }}>
      {icon ? (
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            backgroundColor: instrument.inset,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: instrument.glassBorder,
            alignItems: "center",
            justifyContent: "center",
            marginRight: spacing.sm,
          }}
        >
          <Icon name={icon.name} size={16} color={instrument.mut} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 15, fontWeight: "500", color: destructive ? instrument.danger : instrument.ink }}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: 1 }}>{subtitle}</AppText>
        ) : null}
      </View>
      {detail ? (
        <AppText
          style={{
            fontSize: 15,
            color: instrument.mut,
            marginRight: chevron ? spacing.xs : 0,
            fontVariant: ["tabular-nums"],
          }}
        >
          {detail}
        </AppText>
      ) : null}
      {right}
      {chevron ? <Icon name="chevron-right" size={14} color={instrument.mut} /> : null}
    </View>
  );

  if (onPress) {
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        haptic="none"
        onPress={onPress}
      >
        {content}
      </PressableScale>
    );
  }

  return <View accessibilityLabel={accessibilityLabel}>{content}</View>;
}
