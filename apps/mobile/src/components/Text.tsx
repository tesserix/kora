import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

type Variant = "h1" | "h2" | "h3" | "body" | "caption";

const presets: Record<Variant, { size: number; weight: "400" | "600" | "700"; letterSpacing?: number }> = {
  h1: { size: 36, weight: "700", letterSpacing: -0.9 },
  h2: { size: 30, weight: "700", letterSpacing: -0.75 },
  h3: { size: 24, weight: "600" },
  body: { size: 16, weight: "400" },
  caption: { size: 12, weight: "400" },
};

type Props = TextProps & { variant?: Variant; muted?: boolean };

export function AppText({ variant = "body", muted = false, style, ...rest }: Props) {
  const { colors } = useTheme();
  const p = presets[variant];
  return (
    <Text
      style={[
        {
          fontSize: p.size,
          fontWeight: p.weight,
          letterSpacing: p.letterSpacing,
          color: muted ? colors.mutedForeground : colors.foreground,
        },
        style,
      ]}
      {...rest}
    />
  );
}
