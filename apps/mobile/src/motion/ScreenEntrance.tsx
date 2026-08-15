import { useCallback, type ReactNode } from "react";
import { useFocusEffect } from "expo-router";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { REDUCED_MOTION_CROSSFADE_MS } from "./springs";
import { useMotionPrefs } from "./useMotionPrefs";
import { resolveScreenDirection } from "./screenEntranceDirection";

// Spec (Task 9): fade in from opacity 0 + translateX ±16 over 280ms ease-out.
const ENTRANCE_MS = 280;
const TRANSLATE_X = 16;

export interface ScreenEntranceProps {
  children: ReactNode;
  // This screen's own fixed position in the tab order — Today=0, Diary=1,
  // Trends=2, More=3, matching <Tabs.Screen> order in app/(tabs)/_layout.tsx.
  // Resolved against the last-focused tab (screenEntranceDirection.ts) the
  // instant this screen's own focus effect fires, to decide whether content
  // should slide in from the left (a lower-index tab was showing) or the
  // right (a higher-index one was) — the same "direction from previous vs
  // next tab index" the design contract calls for, computed synchronously
  // inside a single effect rather than passed in pre-resolved.
  direction: number;
}

export function ScreenEntrance({ children, direction }: ScreenEntranceProps) {
  const { reduceMotion } = useMotionPrefs();
  const opacity = useSharedValue(0);
  const translateX = useSharedValue(0);

  useFocusEffect(
    useCallback(() => {
      const dir = resolveScreenDirection(direction);
      if (reduceMotion) {
        // Reduce Motion (spec): 180ms opacity-only crossfade — no lateral
        // travel at all, matching REDUCED_MOTION_CROSSFADE_MS elsewhere
        // (the gauge needle's own reduced-motion substitute).
        translateX.value = 0;
        opacity.value = 0;
        opacity.value = withTiming(1, { duration: REDUCED_MOTION_CROSSFADE_MS });
        return;
      }
      opacity.value = 0;
      translateX.value = dir * TRANSLATE_X;
      opacity.value = withTiming(1, { duration: ENTRANCE_MS, easing: Easing.out(Easing.cubic) });
      translateX.value = withTiming(0, { duration: ENTRANCE_MS, easing: Easing.out(Easing.cubic) });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [direction, reduceMotion]),
  );

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: translateX.value }],
  }));

  return <Animated.View style={[{ flex: 1 }, style]}>{children}</Animated.View>;
}
