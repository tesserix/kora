import { StyleSheet, Text, type TextProps } from "react-native";
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
// The band comes from the AUTHORED size, and so does the result: the platform
// scales the returned line box for Dynamic Type on its own (see AppText below).
// Body copy at 200% is still body copy and still wants body's air, not a
// display leading, so the band is picked before any scaling enters.
function derivedLeading(size: number): number {
  const ratio = size <= 13 ? 1.45 : size <= 17 ? 1.3 : size <= 28 ? 1.22 : 1.15;
  return Math.round(size * ratio);
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
  // `lineHeight` is authored in UNSCALED points, because the platform applies
  // the Dynamic Type scale to it ITSELF — measured on RN 0.86 / New
  // Architecture, iPhone 17 Pro Max (kora#173). A sweep of fifteen lineHeight
  // values from 10 to 80 at fontScale 2.6430 gave a rendered per-line advance
  // of 2.633–2.650x the authored value in every case, and exactly 1.000x with
  // `allowFontScaling={false}`. So the platform multiplies by fontScale, full
  // stop.
  //
  // This code USED to multiply by `PixelRatio.getFontScale()` on the premise
  // that RN scales `fontSize` but never `lineHeight`. That premise is false
  // here, and the scale landed twice: at accessibility-extra-large a 20pt body
  // string got a 169pt line box where ~63pt is correct, which is where the two
  // blank lines between "Welcome" and "back." came from. Do not reintroduce it
  // on reasoning alone — jest cannot observe platform font scaling, so a green
  // suite says nothing here. The measurements, and the Fast Refresh trap that
  // corrupts them, are written up in
  // .planning/debug/resolved/lineheight-double-scaled.md.
  //
  // `allowFontScaling` and `maxFontSizeMultiplier` need no handling either:
  // with scaling off the platform multiplies the box by 1, and a cap scales the
  // rendered box and the glyph by the same capped multiplier, so the authored
  // ratio survives both without help.
  const lineHeight =
    // An explicit caller lineHeight always wins — the handful of call sites
    // that set one picked a specific number for a specific figure. It is passed
    // through in the same unscaled points as everything else here.
    typeof flat.lineHeight === "number" ? flat.lineHeight
      // At the variant's own size, keep its hand-tuned Apple value.
      : size === p.size && p.lineHeight ? p.lineHeight
      : derivedLeading(size);
  return (
    <Text
      // The variant's Apple Dynamic Type ceiling, where it has one — see the
      // `maxScale` note on the type table for the measurements. It goes BEFORE
      // the spread so an explicit caller prop still wins, and it needs no
      // lineHeight handling: a cap scales the rendered box and the glyph by the
      // same capped multiplier, so the authored ratio above survives it.
      maxFontSizeMultiplier={p.maxScale}
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
