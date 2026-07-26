import { useEffect, useRef, useState } from "react";
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
  const prev = useRef(value);
  const [display, setDisplay] = useState(() => format(value));

  useEffect(() => {
    if (reduceMotion) {
      // Snap: cancel any in-flight animation and resync the shared value so
      // the next non-reduced-motion update animates from the right place.
      cancelAnimation(sv);
      sv.value = value;
      setDisplay(format(value));
      prev.current = value;
      return;
    }
    // Animate from wherever sv.value currently sits (the live presentation
    // position — including mid-flight if a prior animation hasn't settled),
    // never reset it to the previous target first: that would snap the
    // display back on rapid successive value changes.
    sv.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
    prev.current = value;
  }, [value, reduceMotion]);                          // eslint-disable-line react-hooks/exhaustive-deps

  useAnimatedReaction(
    () => sv.value,
    (v) => { runOnJS(setDisplay)(format(v)); },
    [format],
  );

  return <Text style={[{ fontVariant: ["tabular-nums"] }, style]}>{display}</Text>;
}
