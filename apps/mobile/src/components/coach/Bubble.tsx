import { StyleSheet, View } from "react-native";
import type { CoachCitation, CoachRole } from "@/api/types";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { CitationChips } from "./CitationChips";

export function Bubble({
  role,
  text,
  citations = [],
  agent,
}: {
  role: CoachRole;
  text: string;
  citations?: CoachCitation[];
  agent?: string;
}) {
  const { instrument } = useTheme();
  const user = role === "user";
  // Engraved byline, same micro-label idiom as ZoneRule: the agent is named
  // beside Otto so the user can see which specialist actually answered.
  const byline = !user && agent ? `Otto · ${agent}` : null;
  const speaker = byline ?? (user ? "You" : "Otto");
  return (
    <View style={{ alignItems: user ? "flex-end" : "flex-start", marginBottom: 12 }}>
      {byline ? (
        <AppText
          maxFontSizeMultiplier={1.4}
          style={{
            fontSize: 10,
            fontWeight: "600",
            letterSpacing: 1.5,
            color: instrument.mut,
            marginBottom: 5,
            marginLeft: 4,
          }}
        >
          {byline.toUpperCase()}
        </AppText>
      ) : null}
      <View
        accessibilityLabel={`${speaker}: ${text}`}
        style={{
          maxWidth: "86%",
          borderRadius: 18,
          borderBottomRightRadius: user ? 6 : 18,
          borderBottomLeftRadius: user ? 18 : 6,
          paddingHorizontal: 14,
          paddingVertical: 11,
          backgroundColor: user ? instrument.inset : instrument.glass,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: user ? instrument.tick : instrument.glassBorder,
        }}
      >
        <AppText style={{ color: instrument.ink, fontSize: 15, lineHeight: 21 }}>{text}</AppText>
      </View>
      {!user ? <CitationChips citations={citations} /> : null}
    </View>
  );
}
