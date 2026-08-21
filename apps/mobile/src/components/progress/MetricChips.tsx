import { ScrollView, StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import type { CompositionMetric, CompositionMetricKey } from "@/lib/bodyCompositionFields";

type Props = {
  metrics: readonly CompositionMetric[];
  value: CompositionMetricKey;
  onChange: (key: CompositionMetricKey) => void;
};

/**
 * The trend's metric picker (kora#45).
 *
 * A scrolling chip row rather than a `SegmentedGlass`, which is the app's one
 * segmented recipe but divides its track into EQUAL widths — at ten metrics
 * that is a 30pt box per label before Dynamic Type touches it, and #288 has
 * already been through what happens to an 11pt label in a box too small for
 * it. A row that scrolls has no such ceiling.
 *
 * Selection is carried by a filled `ink` pill, the same 3:1-clearing treatment
 * #166 gave the segmented control, rather than by a difference between two
 * greys.
 *
 * Nothing here is fixed-height: the chip sizes to its own label so the row
 * grows at accessibility sizes instead of clipping (kora#173, #269, #324).
 */
export function MetricChips({ metrics, value, onChange }: Props) {
  const { instrument } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="metric-chips"
      contentContainerStyle={{ gap: 8, paddingRight: 8 }}
    >
      {metrics.map((metric) => {
        const selected = metric.key === value;
        return (
          <PressableScale
            key={metric.key}
            accessibilityRole="tab"
            accessibilityLabel={`Chart ${metric.label.toLowerCase()}`}
            accessibilityState={{ selected }}
            haptic="selection"
            testID={`metric-chip-${metric.key}`}
            onPress={() => {
              if (!selected) onChange(metric.key);
            }}
            style={{
              paddingVertical: 7,
              paddingHorizontal: 12,
              borderRadius: 999,
              backgroundColor: selected ? instrument.ink : instrument.glass,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: selected ? instrument.ink : instrument.glassBorder,
              justifyContent: "center",
            }}
          >
            <View>
              <AppText
                style={{
                  fontSize: 11,
                  letterSpacing: 1.4,
                  textTransform: "uppercase",
                  color: selected ? instrument.bg : instrument.mut,
                }}
              >
                {metric.label}
              </AppText>
            </View>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
