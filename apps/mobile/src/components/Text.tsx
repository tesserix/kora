import { Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";
import { type as typeScale, type TypeVariant } from "@/theme/palette";

type LegacyVariant = "h1" | "h2" | "h3";
type Variant = TypeVariant | LegacyVariant | "caption";
const legacy: Record<LegacyVariant, TypeVariant> = { h1: "largeTitle", h2: "title1", h3: "title2" };

interface Props extends TextProps { variant?: Variant; muted?: boolean; rounded?: boolean }

export function AppText({ variant = "body", muted = false, rounded = false, style, ...rest }: Props) {
  const { colors, fonts } = useTheme();
  const key: TypeVariant =
    variant in legacy ? legacy[variant as LegacyVariant] : (variant as TypeVariant);
  const p = typeScale[key] ?? typeScale.body;
  return (
    <Text
      style={[
        { fontSize: p.size, fontWeight: p.weight, letterSpacing: p.letterSpacing, lineHeight: p.lineHeight,
          color: muted ? colors.secondaryLabel : colors.label,
          ...(rounded && fonts.rounded ? { fontFamily: fonts.rounded } : null) },
        style,
      ]}
      {...rest}
    />
  );
}
