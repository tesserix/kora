import type { ReactNode } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useMotionPrefs } from "@/motion";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import { withAlpha } from "@/lib/color";
import { parseCoachText, type Block } from "@/lib/coachText";

const T = INSTRUMENT_DARK_FIXED;
const BODY = { color: T.ink, fontSize: 14, lineHeight: 21 } as const;

// Agent replies arrive as markdown-ish prose, and a single AppText renders
// their asterisks and bullets literally. Blocks lay the answer out instead.
function CoachBlocks({ text }: { text: string }) {
  const blocks = parseCoachText(text);
  if (blocks.length === 0) return <AppText style={BODY}>{text}</AppText>;
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((block, index) => (
        <CoachBlock key={index} block={block} />
      ))}
    </View>
  );
}

function CoachBlock({ block }: { block: Block }) {
  const spans = block.spans.map((span, index) => (
    <AppText
      key={index}
      style={[
        BODY,
        span.bold ? { fontWeight: "700" as const } : null,
        span.italic ? { fontStyle: "italic" as const } : null,
      ]}
    >
      {span.text}
    </AppText>
  ));

  if (block.kind === "heading") {
    return (
      <AppText style={{ ...BODY, fontWeight: "700", marginTop: 2 }}>{spans}</AppText>
    );
  }
  if (block.kind === "bullet") {
    return (
      <View style={{ flexDirection: "row", gap: 8 }}>
        <AppText style={{ ...BODY, color: T.mut }}>{block.marker}</AppText>
        <AppText style={{ ...BODY, flexShrink: 1 }}>{spans}</AppText>
      </View>
    );
  }
  return <AppText style={BODY}>{spans}</AppText>;
}

interface Props {
  children: ReactNode;
  /** Who answered, as published in the agent registry. Omitted when the
   *  bubble is Otto's own copy — a greeting or an error — rather than a
   *  reply some agent produced. */
  agent?: string;
}

// Otto's chat bubble — camera avatar + translucent bubble, top-left corner
// squared off (radius 6) to point back at the avatar, per CaptureScreen.jsx.
// Springs in on entrance to mark each new Otto message in the thread. Neutral
// ink/glass tokens, not accent — the bubble is not the surface's single
// primary action (that's the composer's mic/send button).
export function OttoBubble({ children, agent }: Props) {
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
        <Icon name="sparkles" size={16} color={T.bg} />
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
        {agent ? (
          <AppText
            testID="otto-bubble-agent"
            style={{
              color: T.mut,
              fontSize: 10,
              fontWeight: "700",
              letterSpacing: 1,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {agent}
          </AppText>
        ) : null}
        {typeof children === "string" ? (
          <CoachBlocks text={children} />
        ) : (
          <AppText style={BODY}>{children}</AppText>
        )}
      </View>
    </Animated.View>
  );
}
