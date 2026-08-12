import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export type SegmentedGlassOption = { key: string; label: string };

type Props = {
  options: SegmentedGlassOption[];
  value: string;
  onChange: (key: string) => void;
};

// The one app-wide segmented-control recipe (spec: "SEGMENTED CONTROL — one
// style app-wide"): a glass-tinted track holding equal-width segments, the
// active one getting an `inset` well + `glassBorder` ring + `ink` text,
// inactive segments `mut`, labels in the 11px uppercase/tracked engraved
// treatment reserved for instrument zones. It's a plain View (not a
// `GlassPanel`) — glass never stacks on glass, so this is meant to live
// inside a `GlassPanel` or other glass surface, same as Trends' Weight panel.
// Extracted from Trends' original `RangeSegmented` (app/(tabs)/progress.tsx)
// — that screen now consumes this component instead of a local copy.
export function SegmentedGlass({ options, value, onChange }: Props) {
  const { instrument } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: instrument.glass,
        borderRadius: 12,
        padding: 3,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
      }}
    >
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <PressableScale
            key={opt.key}
            accessibilityRole="tab"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected }}
            haptic="selection"
            onPress={() => {
              if (opt.key !== value) onChange(opt.key);
            }}
            style={{
              flex: 1,
              paddingVertical: 7,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? instrument.inset : "transparent",
              borderWidth: selected ? StyleSheet.hairlineWidth : 0,
              borderColor: instrument.glassBorder,
            }}
          >
            <AppText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={{
                fontSize: 11,
                letterSpacing: 1.4,
                textTransform: "uppercase",
                fontWeight: "600",
                color: selected ? instrument.ink : instrument.mut,
              }}
            >
              {opt.label}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}
