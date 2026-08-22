import type { BodyCompositionReading, WeightSource } from "@/api/types";
import { kgFromLb, lbFromKg, type UnitSystem } from "@/units";
import {
  COMPOSITION_METRICS,
  isMassMetric,
  unitLabel,
  type CompositionMetric,
  type CompositionMetricKey,
} from "./bodyCompositionFields";

/**
 * Turning ten optional text fields into a write, without inventing data
 * (kora#45).
 *
 * This is deliberately pure and separate from the form component. What it
 * decides — that an untouched field is ABSENT rather than zero — is the rule
 * the whole schema was shaped around, and it is exactly the kind of rule that
 * is easy to assert about a function and nearly impossible to assert about a
 * rendered sheet. #314's confirm surface parses through here too, so the rule
 * holds for a screenshot-filled form as much as a typed one.
 */

/** What the user has typed, per field. A key may be missing or blank; both mean untouched. */
export type CompositionDraft = Partial<Record<CompositionMetricKey, string>>;

/** Metric values as the API stores them: kg, percent, rating, kcal. */
export type CompositionValues = Partial<Record<CompositionMetricKey, number>>;

/**
 * The body of POST /v1/weight.
 *
 * Optional metrics are OMITTED, not set to undefined and not set to 0 — the
 * server's columns are nullable pointers and a key that is never present is
 * the only shape that reaches them as SQL NULL.
 *
 * `logged_at`/`local_date` (kora#314's date row) are sent on EVERY save, not
 * only an edited one — the alternative, sending them only when the date was
 * actually changed, would need the caller to remember what "unchanged" was.
 * A payload that always states its own date is simpler to reason about, and
 * it costs nothing: when the date is untouched it is just today, which is
 * what the server would have defaulted to anyway. See useAddWeight in
 * src/api/hooks.ts for the trap this exists to close — that hook used to
 * hardcode `local_date` to today unconditionally, which would silently
 * clobber this field.
 */
export type AddWeightPayload = {
  weight_kg: number;
  source: WeightSource;
  logged_at?: string;
  local_date?: string;
} & Partial<Record<Exclude<CompositionMetricKey, "weight_kg">, number>>;

export type CompositionErrors = Partial<Record<CompositionMetricKey, string>>;

export type ParseResult =
  | { ok: true; payload: AddWeightPayload }
  | { ok: false; errors: CompositionErrors };

/**
 * Reads one field's text as a number.
 *
 * `parseFloat` is not enough on its own: it reads "12abc" as 12 and "1.2.3" as
 * 1.2, so a fat-fingered entry would be silently accepted as a different
 * number than the one on screen. A comma IS accepted and normalised, because a
 * decimal-pad keyboard in a comma-decimal locale produces one and rejecting it
 * would look like the app refusing a correctly typed value.
 */
function readNumber(text: string): number | null {
  const normalised = text.trim().replace(",", ".");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/** The message shown when a value is outside what the server will store. */
function rangeMessage(metric: CompositionMetric, system: UnitSystem): string {
  const unit = unitLabel(metric, system);
  const suffix = unit ? ` ${unit}` : "";
  if (metric.range.max === Number.POSITIVE_INFINITY) {
    return `${metric.label} must be more than ${metric.range.min}${suffix}.`;
  }
  return `${metric.label} must be between ${metric.range.min} and ${metric.range.max}${suffix}.`;
}

function inRange(metric: CompositionMetric, stored: number): boolean {
  const { min, max, exclusiveMin } = metric.range;
  if (exclusiveMin ? stored <= min : stored < min) return false;
  return stored <= max;
}

/** Display value -> stored value. Only the kg-backed metrics convert. */
function toStored(metric: CompositionMetric, typed: number, system: UnitSystem): number {
  if (isMassMetric(metric) && system === "imperial") return kgFromLb(typed);
  return typed;
}

/** Stored value -> the string that field should show. */
function toDisplayText(metric: CompositionMetric, stored: number, system: UnitSystem): string {
  if (isMassMetric(metric) && system === "imperial") return lbFromKg(stored).toFixed(1);
  return String(stored);
}

/**
 * Seeds the form from values that already exist.
 *
 * This is the hook #314 hangs its confirm surface on: hand it what the vision
 * pass read and every field arrives pre-filled and editable, in the user's own
 * units. A metric the reader could NOT see must be omitted from `values` — a 0
 * passed here would show up as a typed 0 and get written as a measurement.
 */
export function draftFromValues(values: CompositionValues, system: UnitSystem): CompositionDraft {
  return Object.fromEntries(
    COMPOSITION_METRICS.flatMap((metric) => {
      const stored = values[metric.key];
      if (typeof stored !== "number" || !Number.isFinite(stored)) return [];
      return [[metric.key, toDisplayText(metric, stored, system)]];
    }),
  );
}

/**
 * Validates the whole draft and produces the request body.
 *
 * Every field is checked before returning, so a form with three mistakes shows
 * three messages rather than one per save attempt.
 */
export function parseCompositionDraft(
  draft: CompositionDraft,
  source: WeightSource,
  system: UnitSystem,
): ParseResult {
  const outcomes = COMPOSITION_METRICS.map((metric) => {
    const text = (draft[metric.key] ?? "").trim();

    if (text === "") {
      if (metric.required) {
        const unit = unitLabel(metric, system);
        return { metric, error: `Enter a ${metric.label.toLowerCase()}${unit ? ` in ${unit}` : ""}.` };
      }
      // Untouched. Contributes NOTHING to the payload — not a key, not a zero.
      return { metric };
    }

    const typed = readNumber(text);
    if (typed === null) return { metric, error: `${metric.label} must be a number.` };

    const stored = toStored(metric, typed, system);
    if (!inRange(metric, stored)) return { metric, error: rangeMessage(metric, system) };

    return { metric, stored };
  });

  const errors = Object.fromEntries(
    outcomes.flatMap((o) => (o.error ? [[o.metric.key, o.error]] : [])),
  ) as CompositionErrors;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const measured = Object.fromEntries(
    outcomes.flatMap((o) => (typeof o.stored === "number" ? [[o.metric.key, o.stored]] : [])),
  ) as CompositionValues;

  // weight_kg is present because it is required and validated above; the cast
  // states what the outcomes list already guarantees.
  return { ok: true, payload: { ...measured, source } as AddWeightPayload };
}

/**
 * The draft's currently-valid values, for the live derived readout.
 *
 * Deliberately lenient where `parseCompositionDraft` is strict: a half-typed
 * "7." is not an error while the user is still typing, it is simply not a value
 * yet, so it is omitted. Same omission rule as everywhere else — a field that
 * cannot be read contributes nothing rather than a zero, which is what keeps
 * BMI from flashing an impossible figure mid-keystroke.
 */
export function previewValues(draft: CompositionDraft, system: UnitSystem): CompositionValues {
  return Object.fromEntries(
    COMPOSITION_METRICS.flatMap((metric) => {
      const typed = readNumber(draft[metric.key] ?? "");
      if (typed === null) return [];
      const stored = toStored(metric, typed, system);
      return inRange(metric, stored) ? [[metric.key, stored]] : [];
    }),
  );
}

export type ReadingDateResult = { ok: true; value: string } | { ok: false; error: string };

const READING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the date row BodyCompositionForm adds for kora#314 (see that
 * component's doc comment). Kept separate from parseCompositionDraft because
 * a date is not a composition metric: it never unit-converts and its only
 * bound is "not in the future", not a numeric range.
 *
 * `today` is passed in — "YYYY-MM-DD" — rather than read from `Date.now()`
 * here, so this stays as pure and testable as every other function in this
 * file. The server (internal/bodyread/validate.go) additionally grants one
 * day of grace on reading_date for timezone skew between the SCREENSHOT's
 * own clock and the server's; that grace does not belong here, because this
 * validates what the user just TYPED against the DEVICE's own idea of today
 * — no skew to explain.
 */
export function parseReadingDate(text: string, today: string): ReadingDateResult {
  const trimmed = text.trim();
  if (!READING_DATE_RE.test(trimmed)) return { ok: false, error: "Enter a date as YYYY-MM-DD." };
  if (trimmed > today) return { ok: false, error: "Date can't be in the future." };
  return { ok: true, value: trimmed };
}

/**
 * Turns what the vision pass read into BodyCompositionForm's `initialValues`
 * (kora#314). A structural copy, not a rebuild field-by-field: every numeric
 * key on `BodyCompositionReading` is already named identically to a
 * `CompositionMetricKey`, and JSON's `omitempty` on the wire means a field
 * the model never saw is simply ABSENT from `reading` — so dropping
 * `reading_date` (not a composition metric) is the only work this needs to
 * do. No `?? 0` anywhere on this path: an absent key stays absent.
 */
export function compositionValuesFromReading(reading: BodyCompositionReading): CompositionValues {
  const { reading_date: _readingDate, ...metrics } = reading;
  return metrics;
}
