import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { springs } from "./springs";
import { haptics } from "./haptics";
import { useMotionPrefs } from "./useMotionPrefs";

type HapticKind = keyof typeof haptics | "none";

// Haptics that describe the TOUCH fire with the press-down visual, on the same
// frame; haptics that report an OUTCOME stay on the release that produces it.
// An impact is a physical-contact metaphor — thumping as the finger lifts (up
// to 400ms after contact) reads as a different event entirely. `selection`
// stays on release deliberately: on a tap target the selection only actually
// changes when the press completes.
const PRESS_DOWN_HAPTICS: ReadonlySet<HapticKind> = new Set<HapticKind>(["impactLight"]);

// Reduce Motion fallback. Reanimated 4.5 degrades an animation to an INSTANT
// JUMP, not a cross-fade, so the guard cannot simply be left in place — but
// removing the feedback outright leaves a completely dead button. A short
// opacity dip has no vestibular component at all, so it is the gentler
// equivalent the preference actually asks for.
const REDUCED_PRESS_OPACITY = 0.6;
const REDUCED_PRESS_MS = 100;

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
  const opacity = useSharedValue(1);
  // Only ONE of the two is ever emitted. Emitting both would have the animated
  // style's resting `opacity: 1` silently override a caller that dims itself in
  // its own `style` (a disabled row, say), since `animated` is applied last.
  const animated = useAnimatedStyle(() =>
    reduceMotion ? { opacity: opacity.value } : { transform: [{ scale: scale.value }] },
  );
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
      onPressIn={(e) => {
        if (interactive) {
          if (reduceMotion) opacity.value = withTiming(REDUCED_PRESS_OPACITY, { duration: REDUCED_PRESS_MS });
          else scale.value = withSpring(scaleTo, springs.instant);
        }
        if (PRESS_DOWN_HAPTICS.has(haptic)) haptics[haptic as keyof typeof haptics]();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (interactive) {
          if (reduceMotion) opacity.value = withTiming(1, { duration: REDUCED_PRESS_MS });
          else scale.value = withSpring(1, springs.standard);
        }
        onPressOut?.(e);
      }}
      onPress={(e) => { if (haptic !== "none" && !PRESS_DOWN_HAPTICS.has(haptic)) haptics[haptic](); onPress?.(e); }}
    >
      {children}
    </AnimatedPressable>
  );
}
