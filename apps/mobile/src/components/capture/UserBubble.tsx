import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { useMotionPrefs } from "@/motion";
import { INSTRUMENT_DARK_FIXED } from "@/theme";

const T = INSTRUMENT_DARK_FIXED;

interface Props {
  children: ReactNode;
}

// The user's own message — neutral glass-filled bubble, right-aligned,
// top-right corner squared off (radius 6), per CaptureScreen.jsx. Springs in
// on entrance to mark each new user message in the thread. Not accent — the
// bubble is not the surface's single primary action.
export function UserBubble({ children }: Props) {
  // Reduce Motion: Reanimated 4.5 degrades this to an instant jump, not a
  // cross-fade, so the guard has to substitute a gentler entrance rather than
  // lean on the built-in degradation. Dropping the translate and keeping the
  // fade IS the prescribed fallback.
  const { reduceMotion } = useMotionPrefs();
  return (
    <Animated.View entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(250)} style={{ flexDirection: "row", justifyContent: "flex-end" }}>
      <View
        style={{
          backgroundColor: T.inset,
          borderWidth: 1,
          borderColor: T.glassBorder,
          borderRadius: 16,
          borderTopRightRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 10,
          maxWidth: "80%",
        }}
      >
        <AppText style={{ color: T.ink, fontSize: 14, lineHeight: 21, fontWeight: "500" }}>
          {children}
        </AppText>
      </View>
    </Animated.View>
  );
}
