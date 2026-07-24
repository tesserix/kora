import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";

export function Overline({ style, children, ...rest }: TextProps) {
  const { colors } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        { fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: colors.mutedForeground },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
