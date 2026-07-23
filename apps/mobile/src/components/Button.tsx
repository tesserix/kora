import { Pressable, Text, type PressableProps } from "react-native";
import { useTheme } from "@/theme";

type Variant = "primary" | "secondary" | "ghost";

type Props = Omit<PressableProps, "children"> & {
  title: string;
  variant?: Variant;
};

export function Button({ title, variant = "primary", disabled, ...rest }: Props) {
  const { colors, radius, spacing } = useTheme();
  const bg =
    variant === "primary" ? colors.primary : variant === "secondary" ? colors.secondary : "transparent";
  const fg =
    variant === "primary" ? colors.primaryForeground : variant === "secondary" ? colors.secondaryForeground : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: radius.lg,
        backgroundColor: bg,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
      {...rest}
    >
      <Text style={{ color: fg, fontSize: 16, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
}
