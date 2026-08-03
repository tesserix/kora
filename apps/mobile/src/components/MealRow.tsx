import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "./Text";
import { Numeral } from "./Numeral";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";

type Props = {
  name: string;
  slot: string;
  /** null when the calorie figure is genuinely unknown — renders "— kcal". */
  kcal: number | null;
  iconName?: string;
  tint?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  pinned?: boolean;
  onPinToggle?: () => void;
  bookmarked?: boolean;
  onBookmark?: () => void;
  /** Status capsule shown before the kcal figure (e.g. a sync Badge). */
  badge?: ReactNode;
  /** Fades the kcal figure for a row that is not (yet) part of the day. */
  dimmed?: boolean;
};

export function MealRow({ name, slot, kcal, iconName = "utensils", tint, onPress, accessibilityLabel, pinned, onPinToggle, bookmarked, onBookmark, badge, dimmed }: Props) {
  const { colors, radius, spacing } = useTheme();
  const chip = tint ?? colors.accent;
  return (
    // Not every row is interactive — a pending queued log has nothing to open.
    // Role and haptic follow the handler so a row that does nothing is neither
    // announced as a button nor buzzes under the finger.
    <PressableScale testID="meal-row" accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={accessibilityLabel ?? name} haptic={onPress ? "selection" : "none"} onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, paddingHorizontal: spacing.md }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(chip, 0.16) }}>
        <Icon name={iconName} size={18} color={chip} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="headline">{name}</AppText>
        <AppText variant="footnote" muted>{slot}</AppText>
      </View>
      {badge}
      <View style={{ opacity: dimmed ? 0.5 : 1 }}>
        <Numeral size={17}>{kcal === null ? "— kcal" : `${Math.round(kcal)} kcal`}</Numeral>
      </View>
      {onPinToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pinned ? `Unpin ${name}` : `Pin ${name}`}
          hitSlop={10}
          onPress={onPinToggle}
          style={{ paddingLeft: spacing.sm }}
        >
          <Icon name={pinned ? "star-fill" : "star"} size={20} color={pinned ? colors.accent : colors.tertiaryLabel} />
        </Pressable>
      ) : null}
      {onBookmark ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bookmarked ? `Edit ${name}` : `Save ${name}`}
          hitSlop={10}
          onPress={onBookmark}
          style={{ paddingLeft: spacing.sm }}
        >
          <Icon name={bookmarked ? "bookmark-fill" : "bookmark"} size={20} color={bookmarked ? colors.accent : colors.tertiaryLabel} />
        </Pressable>
      ) : null}
    </PressableScale>
  );
}
