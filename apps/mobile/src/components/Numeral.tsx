import type { TextProps } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = TextProps & { size?: number; weight?: "700" | "800"; color?: string };

// SF Rounded numerals with tabular figures, for stat values and counters.
export function Numeral({ size = 16, weight = "700", color, style, children, ...rest }: Props) {
  const { colors } = useTheme();
  return (
    <AppText
      {...rest}
      rounded
      style={[
        {
          // No lineHeight override: AppText derives the line box from the
          // effective fontSize since kora#177, which is what this used to patch
          // locally (at large sizes body's fixed ~20px box clipped the top of
          // the glyph — a "0" read as a "U").
          fontSize: size,
          fontWeight: weight,
          letterSpacing: -0.3,
          color: color ?? colors.label,
          fontVariant: ["tabular-nums"],
        },
        style,
      ]}
    >
      {children}
    </AppText>
  );
}
