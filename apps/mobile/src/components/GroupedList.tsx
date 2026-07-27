import { Children, type ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type GroupedSectionProps = {
  header?: string;
  footer?: string;
  children: ReactNode;
  style?: ViewStyle;
  elevated?: boolean;
};

// iOS grouped-table-view section: uppercase caption header, a card of rows with
// hairline separators auto-inserted between them (none before the first / after
// the last), and an optional footnote footer.
//
// `elevated` (default false) swaps the rows surface from the flat `colors.card`
// treatment to a real elevated surface (colors.elevated + shadow), so a meal-slot
// section can stand on its own instead of being nested inside a separate <Card>
// (which produced a two-tone, mismatched-radius seam in dark mode). The shadow
// lives on an OUTER wrapper with no overflow — the inner rows view carries the
// overflow:"hidden" + borderRadius clipping — because putting overflow:"hidden"
// and a shadow on the same View clips the shadow on iOS (see Card.tsx).
export function GroupedSection({ header, footer, children, style, elevated = false }: GroupedSectionProps) {
  const { colors, radius, spacing, shadows } = useTheme();
  const rows = Children.toArray(children).filter(Boolean);

  const rowsView = (
    <View
      style={{
        backgroundColor: elevated ? colors.elevated : colors.card,
        borderRadius: elevated ? radius.xl : radius.lg,
        overflow: "hidden",
      }}
    >
      {rows.map((row, index) => (
        <View key={index}>
          {row}
          {index < rows.length - 1 ? (
            <View
              testID="row-sep"
              style={{
                marginLeft: spacing.md,
                height: StyleSheet.hairlineWidth,
                backgroundColor: colors.separator,
              }}
            />
          ) : null}
        </View>
      ))}
    </View>
  );

  return (
    <View style={style}>
      {header ? (
        <AppText
          variant="caption"
          muted
          style={{ marginLeft: spacing.md, marginBottom: spacing.xs, textTransform: "uppercase" }}
        >
          {header}
        </AppText>
      ) : null}
      {elevated ? <View style={{ borderRadius: radius.xl, ...shadows.card }}>{rowsView}</View> : rowsView}
      {footer ? (
        <AppText variant="footnote" muted style={{ marginTop: spacing.xs, marginLeft: spacing.md }}>
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

// A single grouped-list row: 44pt min height, optional tinted squircle icon,
// title/subtitle stack, right-aligned detail, optional chevron. Interactive
// rows (onPress given) use PressableScale; static rows render a plain View.
export function Row({ title, subtitle, detail, icon, chevron, destructive, onPress, right, accessibilityLabel }: RowProps) {
  const { colors, spacing } = useTheme();

  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md }}>
      {icon ? (
        <View
          style={{
            width: 29,
            height: 29,
            borderRadius: 6.5,
            backgroundColor: icon.tint,
            alignItems: "center",
            justifyContent: "center",
            marginRight: spacing.sm,
          }}
        >
          <Icon name={icon.name} size={16} color={colors.primaryForeground} />
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <AppText variant="headline" style={destructive ? { color: colors.destructive } : undefined}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="footnote" muted>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {detail ? (
        <AppText
          variant="subheadline"
          muted
          style={{ marginRight: chevron ? spacing.xs : 0, fontVariant: ["tabular-nums"] }}
        >
          {detail}
        </AppText>
      ) : null}
      {right}
      {chevron ? <Icon name="chevron-right" size={14} color={colors.tertiaryLabel} /> : null}
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
