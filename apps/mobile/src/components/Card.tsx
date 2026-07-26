import { View, type ViewProps } from "react-native";
import { useTheme } from "@/theme";

// Borderless card: a flat elevated surface (no border, no shadow by default) —
// hairline rules between sections carry the visual separation instead.
export function Card({ style, ...rest }: ViewProps) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderRadius: radius.lg,
          padding: spacing.md,
        },
        style,
      ]}
      {...rest}
    />
  );
}
