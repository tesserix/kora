import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Overline } from "@/components/Overline";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import type { WeightSource } from "@/api/types";
import { derivedComposition } from "@/lib/bodyComposition";
import { localDateNow } from "@/lib/localDate";
import { COMPOSITION_METRICS, MANUAL_SOURCES, sourceLabel, type CompositionMetric } from "@/lib/bodyCompositionFields";
import {
  draftFromValues,
  parseCompositionDraft,
  parseReadingDate,
  previewValues,
  type AddWeightPayload,
  type CompositionDraft,
  type CompositionErrors,
  type CompositionValues,
} from "@/lib/bodyCompositionForm";
import { useTheme } from "@/theme";
import { lbFromKg, useUnits, weightUnitLabel } from "@/units";
import { CompositionMetricField } from "./CompositionMetricField";
import { CompositionMoreToggle } from "./CompositionMoreToggle";

// COMPOSITION_METRICS[0] is weight_kg by construction (see that catalogue's
// own "Order is the order a Renpho screenshot reads" comment, and the
// "covers every measured column" test that pins this exact order) — the row
// that stays outside the expanding section, always.
const [WEIGHT_METRIC, ...OTHER_METRICS] = COMPOSITION_METRICS;

/**
 * The earlier of a date-only entry's midday-UTC stamp and the current
 * instant, as an ISO string (kora#378).
 *
 * Returning `now` rather than, say, end-of-day matters: the entry is being
 * saved right now, so once midday has been ruled out "now" is both the most
 * truthful time available and the one value guaranteed to satisfy every
 * `logged_at < to` read the app makes.
 */
function notAfterNow(iso: string): string {
  const stamp = new Date(iso);
  const now = new Date();
  return stamp.getTime() > now.getTime() ? now.toISOString() : iso;
}

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
   * The calendar date this reading is FOR, "YYYY-MM-DD" — #314's screenshot
   * reader's own `reading_date` when it read one legibly, absent otherwise.
   * Kept separate from `initialValues`: a date is not a numeric composition
   * metric and `draftFromValues` has no notion of one. Absent means "today",
   * same as a manual entry gets when this prop is never passed at all.
   */
  initialReadingDate?: string;
  /**
   * The instruments the user may choose between. One entry renders as a stated
   * fact rather than a control, which is what a screenshot import wants: the
   * source is known, and it is not the user's to claim otherwise. Pass more
   * than one (kora#314 PR C: `orderSourcesDetectedFirst`) to offer a
   * pre-selected but CORRECTABLE guess instead — the same control, just fed a
   * detected default as `sources[0]`.
   */
  sources?: readonly WeightSource[];
  /** Profile height, for BMI. Absent simply means no BMI — never a guess. */
  heightCm?: number;
  submitting?: boolean;
  submitLabel?: string;
  /** A save failure from the caller's mutation, shown above the button. */
  error?: string | null;
  /**
   * kora#314 PR C: when true, only the weight field and Save show up front —
   * the other nine fields (source, date, the eight remaining metrics, and the
   * derived readout) sit behind a "More fields" disclosure. Default false
   * keeps every existing caller's full-form layout (kora#45's original
   * manual-entry surface, and #314 PR B's screenshot-confirm surface before
   * this prop existed) exactly as it was.
   */
  expandable?: boolean;
  /**
   * Only consulted when `expandable` is true. `LogWeightSheet` opens Manual
   * mode collapsed (nothing to show yet — protects #45's two-tap weigh-in)
   * and Screenshot mode expanded (a read arrives WITH composition values, so
   * there is something to show immediately). Default false.
   */
  initiallyExpanded?: boolean;
  /**
   * When true, this component renders no inline Save button at all — the
   * caller is responsible for triggering the submit imperatively (see
   * `BodyCompositionFormHandle`). kora#314's silent-failure fix (a Screenshot-
   * mode Save button measuring 743pt below the fold, reachable only by a
   * scroll nothing on screen asked for) is the reason this exists:
   * `LogWeightSheet` hides the inline button here and pins the SAME control,
   * built from this component's own `submit`, in `Sheet`'s `footer` instead.
   * Validation and the save path both stay owned by this component either
   * way — only WHERE the resulting button is drawn moves. Default false
   * keeps every other caller's inline-button layout exactly as it was.
   */
  hideSubmitButton?: boolean;
  onSubmit: (payload: AddWeightPayload) => void;
}

/** Imperative escape hatch for `hideSubmitButton` — see that prop's own comment. */
export interface BodyCompositionFormHandle {
  /**
   * Runs the exact same validate-then-`onSubmit` path the inline Save button
   * would have run: both errors are computed together, both are shown
   * together, and a valid save carries the identical payload shape. A caller
   * that pins the button elsewhere is triggering this component's own logic,
   * never a second copy of it.
   */
  submit: () => void;
}

/**
 * The body-composition entry surface (kora#45, slice 2; expand/collapse added
 * kora#314 PR C).
 *
 * Presentational on purpose — it takes values in and hands a payload back, and
 * knows nothing about the API. That is what lets #314 reuse it as its
 * confirm-with-edit step instead of building a parallel form that would drift
 * on every rule this one encodes.
 *
 * Four of those rules are load-bearing:
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
 * - Collapsing the "More fields" section (when `expandable`) never resets or
 *   discards anything in it — `source`, the date and every metric keep
 *   whatever state they hold while hidden, because a user who expands, types
 *   a value, then collapses to double check the weight must not lose it.
 *
 * A fifth rule, added for #314 PR B: the date row defaults to today and is
 * always editable, and every save states its own `logged_at`/`local_date`
 * explicitly rather than letting the caller's mutation default it — see
 * useAddWeight's own comment on the bug that guards against.
 *
 * Not offered here, and not an oversight: this form does not edit an existing
 * entry. `POST /v1/weight` only creates.
 */
export const BodyCompositionForm = forwardRef<BodyCompositionFormHandle, BodyCompositionFormProps>(
  function BodyCompositionForm(
    {
      initialValues,
      initialReadingDate,
      sources = MANUAL_SOURCES,
      heightCm,
      submitting = false,
      submitLabel = "Save",
      error,
      expandable = false,
      initiallyExpanded = false,
      hideSubmitButton = false,
      onSubmit,
    },
    ref,
  ) {
  const { instrument, spacing } = useTheme();
  const { system } = useUnits();

  // Seeded once per mount. Every caller renders this inside a Sheet, which
  // unmounts its children when dismissed, so a reopened sheet is a fresh form
  // rather than one holding yesterday's half-typed draft.
  const [draft, setDraft] = useState<CompositionDraft>(() => draftFromValues(initialValues ?? {}, system));
  const [errors, setErrors] = useState<CompositionErrors>({});
  const [source, setSource] = useState<WeightSource>(sources[0] ?? "manual");
  const [dateText, setDateText] = useState<string>(() => initialReadingDate ?? localDateNow());
  const [dateError, setDateError] = useState<string | null>(null);
  // Only meaningful when `expandable` — the non-expandable form always shows
  // every field, exactly as it did before this prop existed.
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const showRest = !expandable || expanded;

  const setField = (key: CompositionMetric, text: string) => {
    // A new object, never a mutation of the old draft — and the field's error
    // clears as soon as it is touched, so a message cannot outlive the value
    // that caused it.
    setDraft((prev) => ({ ...prev, [key.key]: text }));
    setErrors((prev) => {
      if (!(key.key in prev)) return prev;
      const { [key.key]: _cleared, ...rest } = prev;
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
    const dateResult = parseReadingDate(dateText, localDateNow());
    // Both are validated before either error is shown, matching
    // parseCompositionDraft's own "report every bad field at once" rule —
    // a save attempt with a bad weight AND a bad date should not require two
    // separate taps to see both messages.
    if (!result.ok || !dateResult.ok) {
      setErrors(result.ok ? {} : result.errors);
      setDateError(dateResult.ok ? null : dateResult.error);
      return;
    }
    setErrors({});
    setDateError(null);
    onSubmit({
      ...result.payload,
      // "T12:00:00Z" mirrors diary.tsx's own water-logging pattern for a
      // date-only entry: a fixed midday-UTC instant keeps logged_at inside
      // localday.Resolve's one-day-either-side tolerance for any real
      // timezone, without claiming a time of day nothing actually recorded.
      //
      // Clamped to now (kora#378). For a PAST date midday is already behind
      // us and nothing changes -- that is the only case the tolerance
      // argument above was ever about. But for TODAY midday UTC is in the
      // future for most of the day, and a future logged_at is invisible to
      // the very screen that just wrote it: useWeightSeries requests
      // `to = now` and the server filters `logged_at < to`, so a weigh-in
      // saved this morning silently vanished until 12:00 UTC -- 17:30 in
      // IST, 22:00 in AEST. It read as a failed save.
      logged_at: notAfterNow(`${dateResult.value}T12:00:00Z`),
      local_date: dateResult.value,
    });
  };

  // No deps array: `onSave` closes over `draft`/`source`/`dateText`, so the
  // handle must be rebuilt every render or a caller triggering it late (the
  // pinned-footer case this exists for) would validate and submit STALE
  // field values instead of whatever the user actually typed last.
  useImperativeHandle(ref, () => ({ submit: onSave }));

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

      <CompositionMetricField
        metric={WEIGHT_METRIC}
        system={system}
        value={draft[WEIGHT_METRIC.key] ?? ""}
        onChangeText={(text) => setField(WEIGHT_METRIC, text)}
        error={errors[WEIGHT_METRIC.key]}
      />

      {expandable ? (
        <CompositionMoreToggle expanded={expanded} onToggle={() => setExpanded((prev) => !prev)} />
      ) : null}

      {showRest ? (
        <>
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

          <View style={{ gap: 4 }}>
            <Field
              label="Date"
              testID="composition-date"
              accessibilityLabel="Reading date"
              value={dateText}
              onChangeText={(text) => {
                setDateText(text);
                setDateError(null);
              }}
              keyboardType="numbers-and-punctuation"
              placeholder="YYYY-MM-DD"
              error={dateError ?? undefined}
            />
            <AppText muted style={{ fontSize: 12 }}>
              Defaults to today — change it if this reading is from another day.
            </AppText>
          </View>

          {OTHER_METRICS.map((metric) => (
            <CompositionMetricField
              key={metric.key}
              metric={metric}
              system={system}
              value={draft[metric.key] ?? ""}
              onChangeText={(text) => setField(metric, text)}
              error={errors[metric.key]}
            />
          ))}

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
              {"Worked out from your weight, height and body fat — not stored, and not editable. Your scale's own figures for these may differ."}
            </AppText>
            <DerivedRow label="BMI" value={derived.bmi === null ? "—" : derived.bmi.toFixed(1)} />
            <DerivedRow label="Fat mass" value={showMass(derived.fatMassKg)} />
            <DerivedRow label="Fat-free mass" value={showMass(derived.fatFreeMassKg)} />
          </View>
        </>
      ) : null}

      {error ? (
        <AppText accessibilityLiveRegion="polite" style={{ color: instrument.danger }}>
          {error}
        </AppText>
      ) : null}

      {hideSubmitButton ? null : <Button title={submitLabel} onPress={onSave} disabled={submitting} />}
    </View>
  );
  },
);

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
