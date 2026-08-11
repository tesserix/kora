import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { withAlpha } from "@/lib/color";
import { monoStyle } from "./instrument/typography";

type Props = {
  name: string;
  slot: string;
  /** null when the calorie figure is genuinely unknown — renders "— kcal". */
  kcal: number | null;
  iconName?: string;
  tint?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  pinned?: boolean;
  onPinToggle?: () => void;
  bookmarked?: boolean;
  onBookmark?: () => void;
  /** Status capsule shown before the kcal figure (e.g. a sync Badge). */
  badge?: ReactNode;
  /** Fades the kcal figure for a row that is not (yet) part of the day. */
  dimmed?: boolean;
  /**
   * Multi-select state. Undefined on screens with no selection mode, so those
   * rows announce nothing; a screen that CAN select passes true/false on every
   * row so assistive tech reads both states. Rendered as a checkmark and an
   * accent wash so the state is visible, not just announced.
   */
  selected?: boolean;
};

// Instrument Glass restyle (C2): mono time/kcal, ink name, mut secondary
// text, an instrument.inset + instrument.glassBorder selection wash (not an
// accent wash — accent stays reserved for the primary CTA/gauge/redline
// elsewhere), and star/bookmark glyphs tinted from instrument.ink at reduced
// opacity rather than accent. Pure restyle — props/behavior unchanged.
export function MealRow({ name, slot, kcal, iconName = "utensils", tint, onPress, onLongPress, accessibilityLabel, pinned, onPinToggle, bookmarked, onBookmark, badge, dimmed, selected }: Props) {
  const { radius, spacing, instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  const chip = tint ?? instrument.mut;
  const glyphOn = instrument.ink;
  const glyphOff = withAlpha(instrument.ink, 0.35);
  return (
    // Not every row is interactive — a pending queued log has nothing to open.
    // Role and haptic follow the handler so a row that does nothing is neither
    // announced as a button nor buzzes under the finger.
    <PressableScale testID="meal-row" accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={accessibilityLabel ?? name} accessibilityState={{ selected }} haptic={onPress ? "selection" : "none"} onPress={onPress} onLongPress={onLongPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: spacing.md,
        borderRadius: radius.md,
        borderWidth: selected ? 1 : 0,
        borderColor: selected ? instrument.glassBorder : "transparent",
        backgroundColor: selected ? instrument.inset : undefined,
      }}>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: selected ? instrument.inset : withAlpha(chip, 0.16) }}>
        <Icon name={selected ? "check" : iconName} size={18} color={selected ? glyphOn : chip} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="headline" style={{ color: instrument.ink }}>{name}</AppText>
        <AppText variant="footnote" style={[{ color: instrument.mut }, mono]}>{slot}</AppText>
      </View>
      {badge}
      <View style={{ opacity: dimmed ? 0.5 : 1 }}>
        <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
          {kcal === null ? "— kcal" : `${Math.round(kcal)} kcal`}
        </AppText>
      </View>
      {onPinToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pinned ? `Unpin ${name}` : `Pin ${name}`}
          hitSlop={10}
          onPress={onPinToggle}
          style={{ paddingLeft: spacing.sm }}
        >
          <Icon name={pinned ? "star-fill" : "star"} size={20} color={pinned ? glyphOn : glyphOff} />
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
          <Icon name={bookmarked ? "bookmark-fill" : "bookmark"} size={20} color={bookmarked ? glyphOn : glyphOff} />
        </Pressable>
      ) : null}
    </PressableScale>
  );
}
