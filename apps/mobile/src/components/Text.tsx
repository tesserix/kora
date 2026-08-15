import { PixelRatio, StyleSheet, Text, type TextProps } from "react-native";
import { useTheme } from "@/theme";
import { type as typeScale, type TypeVariant } from "@/theme/palette";

type LegacyVariant = "h1" | "h2" | "h3";
type Variant = TypeVariant | LegacyVariant | "caption";
const legacy: Record<LegacyVariant, TypeVariant> = { h1: "largeTitle", h2: "title1", h3: "title2" };

interface Props extends TextProps { variant?: Variant; muted?: boolean; rounded?: boolean }

// Apple HIG §15: leading tracks size INVERSELY — small dense copy needs air,
// display type does not. A fixed pt line box (the variant's own) is only right
// at the variant's own size, so any caller that overrides `fontSize` gets a
// ratio-derived box instead. Bands are the same shape as the type scale.
// The band comes from the AUTHORED size, not the scaled one: body copy at 200%
// is still body copy and still wants body's air, not a display leading.
function derivedLeading(size: number, scale: number): number {
  const ratio = size <= 13 ? 1.45 : size <= 17 ? 1.3 : size <= 28 ? 1.22 : 1.15;
  return Math.round(size * ratio * scale);
}

export function AppText({ variant = "body", muted = false, rounded = false, style, ...rest }: Props) {
  const { colors, fonts } = useTheme();
  const key: TypeVariant =
    variant in legacy ? legacy[variant as LegacyVariant] : (variant as TypeVariant);
  const p = typeScale[key] ?? typeScale.body;
  // Caller styles merge AFTER the variant's, so a call site that set only
  // `fontSize` used to keep the variant's line box — 22pt under a 54pt numeral,
  // which clips the glyph, and 22pt under a 10pt label, which is a 2.2 ratio
  // (kora#177). Flatten first and read the size that will actually render.
  const flat = StyleSheet.flatten(style) ?? {};
  const size = typeof flat.fontSize === "number" ? flat.fontSize : p.size;
  // RN scales `fontSize` for Dynamic Type but never `lineHeight`, so a pt line
  // box collapses to zero spacing at accessibility text sizes — multi-line copy
  // runs together and single-line readouts clip. Deriving against the size the
  // OS will actually render keeps the ratio intact at every text size.
  // Whatever the caller does to the glyph's scaling, the box has to follow it:
  // scaling off means scale 1, and a cap on the glyph caps the box too.
  const scale = rest.allowFontScaling === false
    ? 1
    // RN reads 0/null on maxFontSizeMultiplier as "no cap", so `||` not `??`.
    : Math.min(PixelRatio.getFontScale(), rest.maxFontSizeMultiplier || Infinity);
  const lineHeight =
    // An explicit caller lineHeight always wins, unscaled — the handful of call
    // sites that set one picked a specific number for a specific figure.
    typeof flat.lineHeight === "number" ? flat.lineHeight
      // At the variant's own size, keep its hand-tuned Apple value.
      : size === p.size && p.lineHeight ? Math.round(p.lineHeight * scale)
      : derivedLeading(size, scale);
  return (
    <Text
      style={[
        { fontSize: p.size, fontWeight: p.weight, letterSpacing: p.letterSpacing,
          color: muted ? colors.secondaryLabel : colors.label,
          ...(rounded && fonts.rounded ? { fontFamily: fonts.rounded } : null) },
        style,
        { lineHeight },
      ]}
      {...rest}
    />
  );
}
