import { useMemo, useState } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Overline } from "@/components/Overline";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import type { WeightSource } from "@/api/types";
import { derivedComposition } from "@/lib/bodyComposition";
import {
  COMPOSITION_METRICS,
  MANUAL_SOURCES,
  metricAccessibilityLabel,
  sourceLabel,
  unitLabel,
  type CompositionMetric,
} from "@/lib/bodyCompositionFields";
import {
  draftFromValues,
  parseCompositionDraft,
  previewValues,
  type AddWeightPayload,
  type CompositionDraft,
  type CompositionErrors,
  type CompositionValues,
} from "@/lib/bodyCompositionForm";
import { useTheme } from "@/theme";
import { lbFromKg, useUnits, weightUnitLabel } from "@/units";

export interface BodyCompositionFormProps {
  /**
   * Values to pre-fill, in the units the API stores (kg, percent, rating).
   *
   * This is the seam #314 hangs its confirm surface on: hand it what the vision
   * pass read and the user gets this exact form, pre-filled and every value
   * editable, rather than a second screen that has to restate all ten fields
   * and their rules. A metric the reader could NOT see must be OMITTED — a 0
   * here becomes a typed 0 and is written as a measurement.
   */
  initialValues?: CompositionValues;
  /**
   * The instruments the user may choose between. One entry renders as a stated
   * fact rather than a control, which is what a screenshot import wants: the
   * source is known, and it is not the user's to claim otherwise.
   */
  sources?: readonly WeightSource[];
  /** Profile height, for BMI. Absent simply means no BMI — never a guess. */
  heightCm?: number;
  submitting?: boolean;
  submitLabel?: string;
  /** A save failure from the caller's mutation, shown above the button. */
  error?: string | null;
  onSubmit: (payload: AddWeightPayload) => void;
}

/**
 * The body-composition entry surface (kora#45, slice 2).
 *
 * Presentational on purpose — it takes values in and hands a payload back, and
 * knows nothing about the API. That is what lets #314 reuse it as its
 * confirm-with-edit step instead of building a parallel form that would drift
 * on every rule this one encodes.
 *
 * Three of those rules are load-bearing:
 *
 * - Every field but weight is OPTIONAL, and an untouched one stays ABSENT. The
 *   parsing that guarantees it lives in src/lib/bodyCompositionForm.ts, where
 *   it can be asserted directly.
 * - Visceral fat carries no unit, because it is a vendor rating and not a
 *   percentage. `unitLabel` returns "" for it and this component adds nothing.
 * - BMI, fat mass and fat-free mass are shown but cannot be TYPED. They are
 *   derived live from what is on screen, which puts the schema's
 *   derive-don't-store rule where the user can see it rather than only in the
 *   model. There is deliberately no field for them.
 *
 * Not offered here, and not an oversight: this form does not edit an existing
 * entry. `POST /v1/weight` only creates.
 */
export function BodyCompositionForm({
  initialValues,
  sources = MANUAL_SOURCES,
  heightCm,
  submitting = false,
  submitLabel = "Save",
  error,
  onSubmit,
}: BodyCompositionFormProps) {
  const { instrument, spacing } = useTheme();
  const { system } = useUnits();

  // Seeded once per mount. Every caller renders this inside a Sheet, which
  // unmounts its children when dismissed, so a reopened sheet is a fresh form
  // rather than one holding yesterday's half-typed draft.
  const [draft, setDraft] = useState<CompositionDraft>(() => draftFromValues(initialValues ?? {}, system));
  const [errors, setErrors] = useState<CompositionErrors>({});
  const [source, setSource] = useState<WeightSource>(sources[0] ?? "manual");

  const setField = (metric: CompositionMetric, text: string) => {
    // A new object, never a mutation of the old draft — and the field's error
    // clears as soon as it is touched, so a message cannot outlive the value
    // that caused it.
    setDraft((prev) => ({ ...prev, [metric.key]: text }));
    setErrors((prev) => {
      if (!(metric.key in prev)) return prev;
      const { [metric.key]: _cleared, ...rest } = prev;
      return rest;
    });
  };

  const preview = useMemo(() => previewValues(draft, system), [draft, system]);
  const derived = derivedComposition(
    { weight_kg: preview.weight_kg as number, body_fat_pct: preview.body_fat_pct },
    heightCm,
  );

  const onSave = () => {
    const result = parseCompositionDraft(draft, source, system);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onSubmit(result.payload);
  };

  const massUnit = weightUnitLabel(system);
  const showMass = (kg: number | null) =>
    kg === null ? "—" : `${(system === "imperial" ? lbFromKg(kg) : kg).toFixed(1)} ${massUnit}`;

  return (
    <View style={{ gap: spacing.md }} testID="body-composition-form">
      <Overline>Body composition</Overline>
      <AppText muted style={{ fontSize: 13 }}>
        Weight is all that is needed. Fill in whatever else your scale showed — anything you leave blank stays
        unrecorded rather than being stored as zero.
      </AppText>

      <View style={{ gap: 6 }}>
        <Overline style={{ fontSize: 11 }}>Measured with</Overline>
        {sources.length > 1 ? (
          <SegmentedGlass
            testID="composition-source"
            options={sources.map((s) => ({ key: s, label: sourceLabel(s) }))}
            value={source}
            onChange={(key) => setSource(key as WeightSource)}
          />
        ) : (
          <AppText testID="composition-source-fixed" style={{ fontSize: 15, color: instrument.ink }}>
            {sourceLabel(source)}
          </AppText>
        )}
        <AppText muted style={{ fontSize: 12 }}>
          Two instruments measure these differently, so Kora charts each one separately rather than joining them.
        </AppText>
      </View>

      {COMPOSITION_METRICS.map((metric) => {
        const unit = unitLabel(metric, system);
        return (
          <View key={metric.key} style={{ gap: 4 }}>
            <Field
              // The unit rides in the visible label so it cannot drift away from
              // the field at accessibility sizes, the way a separate suffix
              // column does. Visceral fat gets none, because it has none.
              label={unit ? `${metric.label} (${unit})` : metric.label}
              accessibilityLabel={metricAccessibilityLabel(metric, system)}
              value={draft[metric.key] ?? ""}
              onChangeText={(text) => setField(metric, text)}
              keyboardType="decimal-pad"
              placeholder={metric.required ? "" : "Optional"}
              error={errors[metric.key]}
            />
            {metric.note ? (
              <AppText muted style={{ fontSize: 12 }}>
                {metric.note}
              </AppText>
            ) : null}
          </View>
        );
      })}

      <View
        testID="composition-derived"
        style={{
          gap: 6,
          padding: spacing.md,
          borderRadius: 12,
          backgroundColor: instrument.inset,
        }}
      >
        <Overline style={{ fontSize: 11 }}>Calculated</Overline>
        <AppText muted style={{ fontSize: 12 }}>
          Worked out from your weight, height and body fat — not stored, and not editable. Your scale's own
          figures for these may differ.
        </AppText>
        <DerivedRow label="BMI" value={derived.bmi === null ? "—" : derived.bmi.toFixed(1)} />
        <DerivedRow label="Fat mass" value={showMass(derived.fatMassKg)} />
        <DerivedRow label="Fat-free mass" value={showMass(derived.fatFreeMassKg)} />
      </View>

      {error ? (
        <AppText accessibilityLiveRegion="polite" style={{ color: instrument.danger }}>
          {error}
        </AppText>
      ) : null}

      <Button title={submitLabel} onPress={onSave} disabled={submitting} />
    </View>
  );
}

/**
 * One read-only derived figure.
 *
 * A row rather than a fixed-height cell, and it wraps: at accessibility sizes
 * "Fat-free mass" and its value need two lines, and a container that refused
 * to give them would clip the number (kora#173, #269, #324). `flexWrap` plus
 * no height at all is what keeps that from happening.
 */
function DerivedRow({ label, value }: { label: string; value: string }) {
  const { fonts, instrument } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}, calculated: ${value}`}
      style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}
    >
      <AppText style={{ fontSize: 14, color: instrument.mut }}>{label}</AppText>
      <AppText style={{ fontSize: 14, color: instrument.ink, fontFamily: fonts.mono }}>{value}</AppText>
    </View>
  );
}
