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
};

// iOS grouped-table-view section: uppercase caption header, a card of rows with
// hairline separators auto-inserted between them (none before the first / after
// the last), and an optional footnote footer.
export function GroupedSection({ header, footer, children, style }: GroupedSectionProps) {
  const { colors, radius, spacing } = useTheme();
  const rows = Children.toArray(children).filter(Boolean);

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
      <View style={{ backgroundColor: colors.card, borderRadius: radius.lg, overflow: "hidden" }}>
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
