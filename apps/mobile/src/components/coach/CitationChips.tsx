import { View } from "react-native";
import type { CoachCitation } from "@/api/types";
import { AppText } from "@/components/Text";
import { monoStyle } from "@/components/instrument/typography";
import { useTheme } from "@/theme";

export function CitationChips({ citations }: { citations: CoachCitation[] }) {
  const { instrument, fonts } = useTheme();
  if (citations.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
      {citations.map((citation, index) => (
        <View
          key={`${citation.label}-${citation.value}-${index}`}
          style={{ backgroundColor: instrument.inset, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 }}
        >
          <AppText style={[{ color: instrument.mut, fontSize: 10 }, monoStyle(fonts)]}>
            {citation.label} · {citation.value}
          </AppText>
        </View>
      ))}
    </View>
  );
}
