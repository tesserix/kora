import type { ReactNode } from "react";
import { Pressable, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { springs } from "./springs";
import { haptics } from "./haptics";
import { useMotionPrefs } from "./useMotionPrefs";

type HapticKind = keyof typeof haptics | "none";

interface Props extends Omit<PressableProps, "children"> {
  children: ReactNode;
  haptic?: HapticKind;
  scaleTo?: number;
}

export function PressableScale({ children, haptic = "none", scaleTo = 0.96, onPressIn, onPressOut, onPress, ...rest }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => { if (!reduceMotion) scale.value = withSpring(scaleTo, springs.instant); onPressIn?.(e); }}
      onPressOut={(e) => { scale.value = withSpring(1, springs.standard); onPressOut?.(e); }}
      onPress={(e) => { if (haptic !== "none") haptics[haptic](); onPress?.(e); }}
    >
      <Animated.View style={animated}>{children}</Animated.View>
    </Pressable>
  );
}
