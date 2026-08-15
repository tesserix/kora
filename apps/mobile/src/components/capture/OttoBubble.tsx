import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useMotionPrefs } from "@/motion";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import { withAlpha } from "@/lib/color";

const T = INSTRUMENT_DARK_FIXED;

interface Props {
  children: ReactNode;
}

// Otto's chat bubble — camera avatar + translucent bubble, top-left corner
// squared off (radius 6) to point back at the avatar, per CaptureScreen.jsx.
// Springs in on entrance to mark each new Otto message in the thread. Neutral
// ink/glass tokens, not accent — the bubble is not the surface's single
// primary action (that's the composer's mic/send button).
export function OttoBubble({ children }: Props) {
  // Reduce Motion: Reanimated 4.5 degrades this to an instant jump, not a
  // cross-fade, so the guard has to substitute a gentler entrance rather than
  // lean on the built-in degradation. Dropping the translate and keeping the
  // fade IS the prescribed fallback.
  const { reduceMotion } = useMotionPrefs();
  return (
    <Animated.View
      entering={reduceMotion ? FadeIn.duration(150) : FadeInDown.duration(250)}
      style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          flexShrink: 0,
          borderRadius: 9999,
          backgroundColor: T.ink,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 3,
          borderColor: withAlpha(T.ink, 0.22),
        }}
      >
        <Icon name="camera" size={16} color={T.bg} />
      </View>
      <View
        style={{
          flexShrink: 1,
          backgroundColor: T.glass,
          borderWidth: 1,
          borderColor: T.glassBorder,
          borderRadius: 16,
          borderTopLeftRadius: 6,
          paddingHorizontal: 14,
          paddingVertical: 12,
          maxWidth: "80%",
        }}
      >
        <AppText style={{ color: T.ink, fontSize: 14, lineHeight: 21 }}>{children}</AppText>
      </View>
    </Animated.View>
  );
}
