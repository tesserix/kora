import { useEffect, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import { cancelAnimation, Easing, runOnJS, useAnimatedReaction, useSharedValue, withTiming } from "react-native-reanimated";
import { useMotionPrefs } from "./useMotionPrefs";

interface Props {
  value: number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
  duration?: number;
}

const defaultFormat = (n: number): string => Math.round(n).toLocaleString();

export function AnimatedNumber({ value, format = defaultFormat, style, duration = 600 }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const sv = useSharedValue(value);
  // Seeded with the raw number (not a formatted string) so `format` only
  // ever runs on the JS thread — at render time — never inside a worklet.
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (reduceMotion) {
      // Snap: cancel any in-flight animation and resync the shared value so
      // the next non-reduced-motion update animates from the right place.
      cancelAnimation(sv);
      sv.value = value;
      setDisplay(value);
      return;
    }
    // Animate from wherever sv.value currently sits (the live presentation
    // position — including mid-flight if a prior animation hasn't settled),
    // never reset it to the previous target first: that would snap the
    // display back on rapid successive value changes.
    sv.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
  }, [value, reduceMotion]);                          // eslint-disable-line react-hooks/exhaustive-deps

  useAnimatedReaction(
    () => sv.value,
    (v) => {
      // Pass the RAW number to JS via runOnJS. Calling `format` here (on the
      // UI/worklet runtime) would synchronously invoke a JS-thread remote
      // function and crash on device — see AnimatedNumber crash fix.
      runOnJS(setDisplay)(v);
    },
    [],
  );

  return <Text style={[{ fontVariant: ["tabular-nums"] }, style]}>{format(display)}</Text>;
}
