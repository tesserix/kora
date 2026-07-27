import { useId } from "react";
import { StyleSheet } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "@/theme";

// Full-bleed radial gradient wash behind the tab screens: a green wash from
// the top-left and a violet wash from the top-right, both fading to
// transparent well before the screen midpoint. Purely decorative — absolute
// fill, non-interactive — so it sits behind the screen's ScrollView (which
// must render with a transparent background for this to show through).
export function AppBackground() {
  const { colors, gradients } = useTheme();
  const greenId = useId();
  const violetId = useId();

  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none" width="100%" height="100%">
      <Defs>
        <RadialGradient id={greenId} cx="15%" cy="0%" r="60%" gradientUnits="objectBoundingBox">
          <Stop offset="0%" stopColor={gradients.green[0]} stopOpacity={0.13} />
          <Stop offset="60%" stopColor={gradients.green[0]} stopOpacity={0} />
        </RadialGradient>
        <RadialGradient id={violetId} cx="100%" cy="5%" r="55%" gradientUnits="objectBoundingBox">
          <Stop offset="0%" stopColor={colors.sleepMetric} stopOpacity={0.12} />
          <Stop offset="55%" stopColor={colors.sleepMetric} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${greenId})`} />
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${violetId})`} />
    </Svg>
  );
}
