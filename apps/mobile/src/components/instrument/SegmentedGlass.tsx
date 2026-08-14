import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export type SegmentedGlassOption = { key: string; label: string };

type Props = {
  options: SegmentedGlassOption[];
  value: string;
  onChange: (key: string) => void;
  testID?: string;
};

// The one app-wide segmented-control recipe (spec: "SEGMENTED CONTROL — one
// style app-wide"): a glass-tinted track holding equal-width segments, the
// active one lit as a solid `ink` pill carrying `bg` text, inactive segments
// `mut` on the bare track, labels in the 11px uppercase/tracked engraved
// treatment reserved for instrument zones. It's a plain View (not a
// `GlassPanel`) — glass never stacks on glass, so this is meant to live
// inside a `GlassPanel` or other glass surface, same as Trends' Weight panel.
// Extracted from Trends' original `RangeSegmented` (app/(tabs)/progress.tsx)
// — that screen now consumes this component instead of a local copy.
//
// kora#166: the selected segment used to be an `inset` well + `glassBorder`
// ring. Both tokens are near-transparent tints of the surface they sit on, so
// composited over the glass track the "selected" pill measured ~1.2:1 against
// its own surroundings — well under WCAG 2.1 SC 1.4.11's 3:1 floor for a UI
// component's state indicator, and in practice invisible. Reading which of
// Male/Female was active meant comparing two label greys. The fill is now the
// existing `ink` token (the same value `tickLit` uses for a lit instrument
// mark), which clears 3:1 by an order of magnitude in both schemes without
// introducing any new colour — `accent` stays reserved for the rulers' centre
// index, so the control does not compete with them for the one accent.
export function SegmentedGlass({ options, value, onChange, testID = "segmented-glass" }: Props) {
  const { instrument } = useTheme();
  return (
    <View
      testID={testID}
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
            testID={`${testID}-segment-${opt.key}`}
            style={{
              flex: 1,
              paddingVertical: 7,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: selected ? instrument.ink : "transparent",
              // The border is drawn on every segment, selected or not, so the
              // pill cannot change the row's metrics as it moves — a hairline
              // appearing on selection shifts the label by half a point and
              // makes the whole control twitch.
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: selected ? instrument.ink : "transparent",
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
                // Inverted on the lit pill: `bg` is the page colour, so the
                // active label reads as cut out of the fill rather than
                // printed on it.
                color: selected ? instrument.bg : instrument.mut,
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
