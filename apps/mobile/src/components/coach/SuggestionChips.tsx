import { View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

const SUGGESTIONS = [
  "How is my protein today?",
  "What should I focus on?",
  "How has my week looked?",
];

export function SuggestionChips({ disabled, onSelect }: { disabled: boolean; onSelect: (question: string) => void }) {
  const { instrument } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {SUGGESTIONS.map((question) => (
        <PressableScale
          key={question}
          accessibilityRole="button"
          accessibilityLabel={`Ask: ${question}`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          haptic="selection"
          onPress={() => onSelect(question)}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 22, backgroundColor: instrument.inset }}
        >
          <AppText style={{ color: instrument.mut, fontSize: 12, fontWeight: "600" }}>{question}</AppText>
        </PressableScale>
      ))}
    </View>
  );
}
