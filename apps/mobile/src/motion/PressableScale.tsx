import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { springs } from "./springs";
import { haptics } from "./haptics";
import { useMotionPrefs } from "./useMotionPrefs";

type HapticKind = keyof typeof haptics | "none";

interface Props extends Omit<PressableProps, "children" | "style"> {
  children: ReactNode;
  haptic?: HapticKind;
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// The caller's `style` and the scale transform are applied to the SAME element
// that holds the children (the Pressable itself, made animated) — no extra
// wrapper view. A previous version wrapped children in a separate Animated.View,
// so layout props like `flexDirection: "row"` landed on the Pressable (whose
// only child was that wrapper) and did nothing — row-laid-out content stacked
// vertically. Keeping the style on the child-bearing element fixes that while
// still honoring outer flex/margin for callers that pass `flex: 1` etc.
export function PressableScale({ children, haptic = "none", scaleTo = 0.96, onPressIn, onPressOut, onPress, onLongPress, style, ...rest }: Props) {
  const { reduceMotion } = useMotionPrefs();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // A PressableScale with no handler is decoration, and springing under the
  // finger promises an interaction it does not have — the same false affordance
  // as an accessibilityRole of "button" or a haptic on an inert row (see
  // MealRow, whose pending queued rows render exactly that way). onLongPress
  // counts: app/friends.tsx has a row whose only interaction is a hold.
  const interactive = Boolean(onPress || onLongPress);
  return (
    <AnimatedPressable
      {...rest}
      onLongPress={onLongPress}
      style={[style, animated]}
      onPressIn={(e) => { if (!reduceMotion && interactive) scale.value = withSpring(scaleTo, springs.instant); onPressIn?.(e); }}
      onPressOut={(e) => { if (interactive) scale.value = reduceMotion ? 1 : withSpring(1, springs.standard); onPressOut?.(e); }}
      onPress={(e) => { if (haptic !== "none") haptics[haptic](); onPress?.(e); }}
    >
      {children}
    </AnimatedPressable>
  );
}
