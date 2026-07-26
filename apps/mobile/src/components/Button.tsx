import type { PressableProps, StyleProp, ViewStyle } from "react-native";
import { PressableScale, type haptics } from "@/motion";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Variant = "primary" | "secondary" | "ghost" | "destructive";

type Props = Omit<PressableProps, "children" | "style"> & {
  title: string;
  variant?: Variant;
  style?: StyleProp<ViewStyle>;
};

const HAPTIC: Record<Variant, keyof typeof haptics | "none"> = {
  primary: "impactLight",
  secondary: "none",
  ghost: "none",
  destructive: "none",
};

export function Button({ title, variant = "primary", disabled, style, onPress, ...rest }: Props) {
  const { colors, radius, spacing } = useTheme();
  const bg = variant === "primary" ? colors.accent : variant === "secondary" ? colors.cardSecondary : "transparent";
  const fg =
    variant === "primary"
      ? colors.primaryForeground
      : variant === "destructive"
        ? colors.destructive
        : variant === "ghost"
          ? colors.accent
          : colors.label;

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
      <AppText variant="headline" style={{ color: fg }}>
        {title}
      </AppText>
    </PressableScale>
  );
}
