import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

type Props = TextProps & { size?: number; weight?: "700" | "800"; color?: string };

export function Numeral({ size = 16, weight = "800", color, style, children, ...rest }: Props) {
  const { colors, fonts } = useTheme();
  return (
    <Text
      {...rest}
      style={[{ fontFamily: fonts.mono, fontSize: size, fontWeight: weight, letterSpacing: -0.3, color: color ?? colors.foreground }, style]}
    >
      {children}
    </Text>
  );
}
