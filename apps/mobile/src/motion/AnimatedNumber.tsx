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
    if (reduceMotion) { cancelAnimation(sv); prev.current = value; setDisplay(format(value)); return; }
    sv.value = prev.current;                         // animate from current presentation, never zero
    prev.current = value;
    sv.value = withTiming(value, { duration, easing: Easing.out(Easing.cubic) });
  }, [value, reduceMotion]);                          // eslint-disable-line react-hooks/exhaustive-deps

  useAnimatedReaction(
    () => sv.value,
    (v) => { runOnJS(setDisplay)(format(v)); },
    [format],
  );

  return <Text style={[{ fontVariant: ["tabular-nums"] }, style]}>{display}</Text>;
}
