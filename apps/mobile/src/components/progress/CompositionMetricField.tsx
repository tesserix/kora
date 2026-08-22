import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Field } from "@/components/Field";
import { metricAccessibilityLabel, unitLabel, type CompositionMetric } from "@/lib/bodyCompositionFields";
import type { UnitSystem } from "@/units";

interface Props {
  metric: CompositionMetric;
  system: UnitSystem;
  value: string;
  onChangeText: (text: string) => void;
  error?: string;
}

/**
 * One labelled numeric field for a body-composition metric, plus its note
 * where it has one (kora#314 PR C).
 *
 * Extracted out of `BodyCompositionForm` — that component renders this exact
 * row for the weight field AND for each of the other nine metrics, and once
 * the weight field had to move out of the `COMPOSITION_METRICS.map(...)` loop
 * (to sit above the expanding "More fields" section) restating the row twice
 * would have been the alternative.
 */
export function CompositionMetricField({ metric, system, value, onChangeText, error }: Props) {
  const unit = unitLabel(metric, system);
  return (
    <View style={{ gap: 4 }}>
      <Field
        // The unit rides in the visible label so it cannot drift away from
        // the field at accessibility sizes, the way a separate suffix
        // column does. Visceral fat gets none, because it has none.
        label={unit ? `${metric.label} (${unit})` : metric.label}
        accessibilityLabel={metricAccessibilityLabel(metric, system)}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder={metric.required ? "" : "Optional"}
        error={error}
      />
      {metric.note ? (
        <AppText muted style={{ fontSize: 12 }}>
          {metric.note}
        </AppText>
      ) : null}
    </View>
  );
}
