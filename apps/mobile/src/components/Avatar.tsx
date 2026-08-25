import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

type Props = { initials: string; size?: number; uri?: string | null };

// The initial is authored at this fraction of the circle's diameter.
const GLYPH_RATIO = 0.38;
// The largest fraction a circle of `size` can hold before the glyph touches
// its edge. Measured against the cap height of two uppercase letters, which is
// the widest thing `initials()` produces.
const MAX_GLYPH_RATIO = 0.58;

// The circle is a fixed `size` and the glyph inside it was uncapped, so at
// accessibility text sizes the letter outgrew the thing containing it — at AX5
// a 15.2pt initial renders near 53pt inside a 40pt circle, spilling out of the
// avatar and, on Home, off the right edge of the screen entirely (kora#324).
//
// Capped rather than grown, for three reasons. The initial is DECORATIVE: every
// call site wraps it in a control that carries its own accessibilityLabel
// ("Profile" on Home), so the letter is never the accessible name and a screen
// reader user loses nothing. Its sibling in the same header row is a fixed
// `Icon size={22}` that does not scale either, so an icon-sized identity chip
// behaving like an icon is the consistent choice. And growing it would eat
// header width the greeting needs — the mistake kora#284 was about.
//
// Derived from the geometry rather than picked, so it holds at every call site
// (32 in friends, 40 on Home, 72 on profile) without a per-size number: it is
// the ratio that can grow, not the points.
const MAX_FONT_SCALE = MAX_GLYPH_RATIO / GLYPH_RATIO;

// Instrument Glass inset well — swapped from `colors.cardSecondary` /
// `colors.label`, both of which carry a faint green tint in dark mode (spec:
// "Avatar.tsx ... only if they leak green — check").
export function Avatar({ initials, size = 40, uri }: Props) {
  const { instrument } = useTheme();
  // An empty string is the API's "no picture" value, not a URL. Treating it as
  // one renders a broken image inside a friend row — worse than the initials
  // it replaced. Same for null, which is what a stale cache returns.
  const hasPicture = typeof uri === "string" && uri.length > 0;
  // A 404, a transient CDN blip, or a deleted object with a stale avatar_url
  // all fail the same way: onError fires, and the letters take over instead
  // of a permanently blank circle (kora#449 task 15 finding 2). Reset on
  // every `uri` change so a fresh upload isn't stuck showing initials because
  // an earlier URL once failed -- adjusted during render (React's documented
  // pattern for state derived from a changing prop, not an effect) so a
  // fresh `uri` can't render one stale failed frame first.
  const [failed, setFailed] = useState(false);
  const [lastUri, setLastUri] = useState(uri);
  if (uri !== lastUri) {
    setLastUri(uri);
    setFailed(false);
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {hasPicture && !failed ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          accessible={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <AppText
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          style={{ fontSize: size * GLYPH_RATIO, fontWeight: "600", color: instrument.ink }}
        >
          {initials}
        </AppText>
      )}
    </View>
  );
}
