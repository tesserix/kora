import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming, Easing } from "react-native-reanimated";
import { useTheme } from "@/theme";

// One-shot highlight band that crosses the cluster glass on mount.
// Parent clips (GlassPanel already has overflow: hidden).
export function SpecularSweep({ width = 400 }: { width?: number }) {
  const { instrument } = useTheme();
  const x = useSharedValue(-width);
  useEffect(() => {
    x.value = withDelay(500, withTiming(width, { duration: 1600, easing: Easing.bezier(0.4, 0, 0.2, 1) }));
  }, [width, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { rotate: "20deg" }] }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <LinearGradient
        colors={["transparent", instrument.glassHighlight, "transparent"]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ width: 90, height: "160%", alignSelf: "center", opacity: 0.8 }}
      />
    </Animated.View>
  );
}
