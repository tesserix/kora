import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

type Props = {
  icon?: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
};

// The selectable card from design-system/ui_kits/kora/Onboarding.jsx. Selection
// is carried by three signals at once — border, tile fill and the radio —
// because a single accent-coloured cue is easy to miss and conveys nothing to a
// colour-blind user.
//
// `icon` is optional, and the two uses differ deliberately: the goal picker
// passes one, the activity list does not. Five icon tiles would read as a wall
// of identical squares, and the activity levels are already distinguished by
// their descriptors.
//
// Built on PressableScale, which already gates its spring on useMotionPrefs, so
// the reduced-motion requirement is inherited here — do not add a second check.
export function SelectableCard({ icon, title, subtitle, selected, onPress }: Props) {
  const { colors, radius, spacing, shadows } = useTheme();

  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      haptic="selection"
      onPress={onPress}
      style={{
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        padding: spacing.md,
        borderRadius: radius.xl,
        backgroundColor: colors.card,
        borderWidth: 2,
        borderColor: selected ? colors.primary : colors.border,
        ...(selected ? shadows.md : null),
      }}
    >
      {icon ? (
        <View
          testID="selectable-icon-tile"
          style={{
            width: 42,
            height: 42,
            borderRadius: radius.lg,
            backgroundColor: selected ? colors.primary : colors.cardSecondary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={20} color={selected ? colors.primaryForeground : colors.primary} />
        </View>
      ) : null}

      <View style={{ flex: 1 }}>
        <AppText variant="headline">{title}</AppText>
        {subtitle ? (
          <AppText variant="footnote" muted>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: selected ? colors.primary : "transparent",
          borderWidth: selected ? 0 : 2,
          borderColor: colors.border,
        }}
      >
        {selected ? <Icon name="check" size={14} color={colors.primaryForeground} /> : null}
      </View>
    </PressableScale>
  );
}
