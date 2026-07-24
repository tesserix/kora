import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, View } from "react-native";
import { captureColors } from "./captureTheme";

type Props = { active: boolean };

// Bar heights lifted verbatim from CaptureScreen.jsx's voice-listening waveform.
const BAR_HEIGHTS = [10, 20, 14, 26, 16, 22, 12, 18, 10] as const;
const BAR_WIDTH = 3;
const BAR_GAP = 4;
const SCALE_UP = 1.9;
const CYCLE_MS = 1000;

// Animated voice-listening waveform. Honors the platform's reduce-motion
// setting by falling back to static bars instead of looping the scale
// animation — mirrors the mockup's `tsx-wave` keyframes.
export function Waveform({ active }: Props) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const scales = useRef(BAR_HEIGHTS.map(() => new Animated.Value(1))).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReducedMotion(enabled);
      })
      .catch(() => {
        if (!cancelled) setReducedMotion(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) {
      scales.forEach((value) => value.setValue(1));
      return undefined;
    }

    const animations = scales.map((value, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 90),
          Animated.timing(value, { toValue: SCALE_UP, duration: CYCLE_MS / 2, useNativeDriver: true }),
          Animated.timing(value, { toValue: 1, duration: CYCLE_MS / 2, useNativeDriver: true }),
        ]),
      ),
    );
    animations.forEach((animation) => animation.start());
    return () => {
      animations.forEach((animation) => animation.stop());
    };
  }, [active, reducedMotion, scales]);

  return (
    <View
      accessibilityLabel="Listening waveform"
      style={{ flexDirection: "row", alignItems: "center", gap: BAR_GAP, height: 26 }}
    >
      {BAR_HEIGHTS.map((height, i) => (
        <Animated.View
          key={i}
          testID="waveform-bar"
          style={{
            width: BAR_WIDTH,
            height,
            borderRadius: BAR_WIDTH,
            backgroundColor: captureColors.primary,
            transform: [{ scaleY: scales[i] }],
          }}
        />
      ))}
    </View>
  );
}
