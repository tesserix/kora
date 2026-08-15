import { useEffect, useRef, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useMotionPrefs } from "./useMotionPrefs";
import { REDUCED_MOTION_CROSSFADE_MS } from "./springs";

interface Props {
  value: number;
  format?: (n: number) => string;
  style?: StyleProp<TextStyle>;
  duration?: number;
}

const defaultFormat = (n: number): string => Math.round(n).toLocaleString();

const AnimatedText = Animated.createAnimatedComponent(Text);

export function AnimatedNumber({ value, format = defaultFormat, style, duration = 600 }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const sv = useSharedValue(value);
  const opacity = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  // Seeded with the raw number (not a formatted string) so `format` only
  // ever runs on the JS thread — at render time — never inside a worklet.
  const [display, setDisplay] = useState(value);
  // First paint has no previous figure to cross-fade FROM, so it must land
  // straight away — fading a number in from nothing on mount is not the
  // reduced-motion equivalent of anything, it is just a slower first paint.
  const firstRun = useRef(true);

  useEffect(() => {
    if (reduceMotion) {
      // Cancel any in-flight count and resync the shared value so the next
      // non-reduced-motion update animates from the right place.
      cancelAnimation(sv);
      if (firstRun.current) {
        sv.value = value;
        setDisplay(value);
      } else {
        // Spec (Motion > prefers-reduced-motion): a sweep becomes a
        // CROSS-FADE, not a jump cut — which is what reanimated 4.5's own
        // degradation would have produced. The figure fades out, swaps at the
        // midpoint, and fades back in; there is no vestibular component to a
        // change in opacity.
        opacity.value = withSequence(
          withTiming(0, { duration: REDUCED_MOTION_CROSSFADE_MS / 2 }, () => {
            "worklet";
            // Resyncing sv HERE (rather than before the fade) is what makes
            // the swap land at the midpoint: the reaction below is what
            // normally drives `display`, and setting sv up front would have
            // it repaint the new figure while the old one was still visible.
            sv.value = value;
            // Belt and braces, and the only path under Jest — the reanimated
            // mock NOOPs useAnimatedReaction. Unconditional rather than gated
            // on `finished`, so an interrupted fade still leaves the correct
            // number on screen.
            runOnJS(setDisplay)(value);
          }),
          withTiming(1, { duration: REDUCED_MOTION_CROSSFADE_MS / 2 }),
        );
      }
      firstRun.current = false;
      return;
    }
    firstRun.current = false;
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

  return <AnimatedText style={[{ fontVariant: ["tabular-nums"] }, style, animatedStyle]}>{format(display)}</AnimatedText>;
}
