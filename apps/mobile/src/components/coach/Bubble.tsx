import { StyleSheet, View } from "react-native";
import type { CoachCitation, CoachRole } from "@/api/types";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import { CitationChips } from "./CitationChips";

export function Bubble({ role, text, citations = [] }: { role: CoachRole; text: string; citations?: CoachCitation[] }) {
  const { instrument } = useTheme();
  const user = role === "user";
  return (
    <View style={{ alignItems: user ? "flex-end" : "flex-start", marginBottom: 12 }}>
      <View
        accessibilityLabel={`${user ? "You" : "Otto"}: ${text}`}
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
