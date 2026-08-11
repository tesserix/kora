import { View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { PressableScale, type haptics } from "@/motion";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

type Variant = "primary" | "secondary" | "ghost" | "destructive";

type Props = Omit<PressableProps, "children" | "style"> & {
  title: string;
  variant?: Variant;
  icon?: string;
  // Defaults to "leading" so every existing call site keeps its current layout.
  iconPosition?: "leading" | "trailing";
  style?: StyleProp<ViewStyle>;
};

const HAPTIC: Record<Variant, keyof typeof haptics | "none"> = {
  primary: "impactLight",
  secondary: "none",
  ghost: "none",
  destructive: "none",
};

// Restyled to Instrument Glass tokens: the old `colors.accent`/`colors.primary`
// was green, and this is the one shared CTA component every in-scope
// More-subscreen relies on for its primary action (friends/groups/challenge/
// reminders/feedback). `instrument.accent` is the single universal accent
// (#FF4A00, same value in both themes), so this swap holds even for the
// remaining legacy call sites (sign-in, onboarding) that haven't migrated
// their surrounding chrome yet — it's a move toward the spec's end state,
// never away from it.
export function Button({
  title,
  variant = "primary",
  icon,
  iconPosition = "leading",
  disabled,
  style,
  onPress,
  ...rest
}: Props) {
  const { instrument, radius, spacing } = useTheme();
  const bg = variant === "primary" ? instrument.accent : variant === "secondary" ? instrument.inset : "transparent";
  const fg =
    variant === "primary"
      ? instrument.accentOn
      : variant === "destructive"
        ? instrument.danger
        : variant === "ghost"
          ? instrument.accent
          : instrument.ink;

  return (
    <PressableScale
      {...rest}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      haptic={HAPTIC[variant]}
      onPress={onPress}
      style={[
        {
          minHeight: 50,
          borderRadius: radius.lg,
          backgroundColor: bg,
          paddingHorizontal: spacing.lg,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {icon ? (
        <View testID="button-content" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {iconPosition === "leading" ? <Icon name={icon} size={18} color={fg} /> : null}
          <AppText variant="headline" style={{ color: fg }}>
            {title}
          </AppText>
          {iconPosition === "trailing" ? <Icon name={icon} size={18} color={fg} /> : null}
        </View>
      ) : (
        <AppText variant="headline" style={{ color: fg }}>
          {title}
        </AppText>
      )}
    </PressableScale>
  );
}
