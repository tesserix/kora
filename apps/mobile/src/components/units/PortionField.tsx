import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { pluralizeUnit, type ServingUnit } from "@/units/portion";

interface PortionFieldProps {
  baseUnit: "g" | "ml";
  servingUnits: ServingUnit[];
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
  /**
   * Visual variant. Backward-compatible: omitted (or "default") renders
   * exactly as before — the legacy cardSecondary stepper buttons used by
   * app/log.tsx and src/components/meals/SavedMealSheet.tsx. "instrument"
   * restyles the stepper mode's -/+ buttons and center value for the
   * instrument-glass meal detail screen (app/meal.tsx): a glassBorder pill
   * on an inset well, accent glyphs, and a mono tabular-nums value. Exact
   * mode (the TextInput + unit chips) is unchanged in both variants.
   */
  variant?: "default" | "instrument";
}

// Display-only rounding for the "(16.5 g)" stepper hint. This figure never
// leaves the component — the server resolves the authoritative grams from
// the reported (amount, unit) pair.
function formatDisplay(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function PortionField({ baseUnit, servingUnits, amount, unit, onChange, variant = "default" }: PortionFieldProps) {
  const { colors, spacing, radius, fonts, instrument } = useTheme();

  const matchingServing = servingUnits.find((s) => s.name === unit);

  // Escape hatch is a one-way UI choice, not data — it's fine as local state.
  // The stepper's amount/unit are never mirrored into local state below: they
  // come straight from props on every render, so a parent that reseeds
  // `amount` (e.g. once an async fetch lands) is reflected immediately
  // instead of being shadowed by a stale copy.
  const [enteredExactMode, setEnteredExactMode] = useState(false);
  const mode: "stepper" | "exact" = matchingServing && !enteredExactMode ? "stepper" : "exact";

  // Exact-mode text is local (so an in-progress edit like "1." isn't
  // clobbered on every keystroke) but reconciled below whenever the parent
  // passes a genuinely new (amount, unit) — as opposed to the echo of our
  // own last onChange call.
  const [exactText, setExactText] = useState(() => String(amount));
  const [exactUnit, setExactUnit] = useState(() => (matchingServing ? baseUnit : unit));
  const lastReported = useRef<{ amount: number; unit: string } | null>(null);

  useEffect(() => {
    const isEcho = lastReported.current?.amount === amount && lastReported.current?.unit === unit;
    if (isEcho) return;
    setExactText(String(amount));
    // While a named serving is active, `unit` is the serving name, not a
    // valid exact-mode unit — leave the baseUnit default in place for when
    // the escape hatch is used.
    if (!matchingServing) setExactUnit(unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, unit]);

  const unitOptions = [baseUnit, ...servingUnits.map((s) => s.name)];

  const increase = () => onChange(amount + 1, unit);

  const decrease = () => {
    // Zero servings is not a portion, so decrementing at 1 does nothing.
    if (amount <= 1) return;
    onChange(amount - 1, unit);
  };

  // Leaving a named serving for exact entry must not relabel the COUNT as a
  // base-unit figure: "2" sachets becoming "2 g" is the same reinterpretation
  // the unit chips make, seen from the other side. Seed the field from the
  // serving's own base amount instead, so it keeps describing the same
  // portion. This is a quantity the food row already carries — no nutrition
  // is derived, and nothing is reported until the user actually edits, so the
  // pending entry is still the named serving the server will resolve.
  //
  // exactUnit is independent state and can still be holding a serving NAME
  // from an earlier exact-mode selection. Left alone, the field would open
  // showing the serving's GRAM figure with the serving chip highlighted, and
  // tapping the base chip would reread 16.5 g as 16.5 sachets — 272 g, the
  // original bug verbatim. Only the call sites keeping `unit` and
  // `servingUnits` in lockstep make that unreachable today, and that is an
  // invariant this component cannot enforce, so it resets the unit here to
  // match the base-unit figure it just seeded.
  const enterExactMode = () => {
    if (matchingServing && matchingServing.amount > 0) {
      setExactText(formatDisplay((matchingServing.base_amount / matchingServing.amount) * amount));
    }
    setExactUnit(baseUnit);
    setEnteredExactMode(true);
  };

  const reportExact = (text: string, selectedUnit: string) => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastReported.current = { amount: parsed, unit: selectedUnit };
      onChange(parsed, selectedUnit);
    }
  };

  const onExactTextChange = (text: string) => {
    setExactText(text);
    reportExact(text, exactUnit);
  };

  // Switching the unit must never REINTERPRET the current figure under the
  // new unit. "16.5" typed as grams is not 16.5 sachets — carrying the number
  // across turned one 16.5 g sachet into 272 g of it. So the count is
  // recomputed for the unit being selected, and only ever as a QUANTITY (the
  // serving's own base amount, which the food row already carries); no
  // nutrition is derived here, and the server still resolves the authoritative
  // grams from the reported pair.
  const countForUnit = (from: string, to: string): number => {
    const fromServing = servingUnits.find((s) => s.name === from);
    const toServing = servingUnits.find((s) => s.name === to);
    const current = Number(exactText);
    // Bulk → named serving, or one named serving → another: there is no
    // meaningful count to carry, so start at one of the new thing.
    if (toServing) return 1;
    // Named serving → the base unit: the serving's own base amount IS the
    // equivalent quantity, so the field keeps describing the same portion.
    if (fromServing && fromServing.amount > 0 && Number.isFinite(current) && current > 0) {
      return (fromServing.base_amount / fromServing.amount) * current;
    }
    return Number.isFinite(current) && current > 0 ? current : 1;
  };

  const onExactUnitChange = (selectedUnit: string) => {
    if (selectedUnit === exactUnit) return;
    const nextAmount = countForUnit(exactUnit, selectedUnit);
    const nextText = formatDisplay(nextAmount);
    setExactUnit(selectedUnit);
    setExactText(nextText);
    reportExact(nextText, selectedUnit);
  };

  // "instrument" pill: glassBorder ring on an inset well, matching the
  // meal-detail spec's stepper treatment; "default" keeps the original
  // cardSecondary circle used by every other caller.
  const stepButtonStyle =
    variant === "instrument"
      ? {
          width: 32,
          height: 32,
          borderRadius: radius.full,
          backgroundColor: instrument.inset,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: instrument.glassBorder,
          alignItems: "center" as const,
          justifyContent: "center" as const,
        }
      : {
          width: 32,
          height: 32,
          borderRadius: radius.full,
          backgroundColor: colors.cardSecondary,
          alignItems: "center" as const,
          justifyContent: "center" as const,
        };
  const stepIconColor = variant === "instrument" ? instrument.accent : colors.label;
  const stepperValueStyle =
    variant === "instrument"
      ? {
          flex: 1,
          textAlign: "center" as const,
          color: instrument.ink,
          fontFamily: fonts.mono,
          fontVariant: ["tabular-nums" as const],
        }
      : { flex: 1, textAlign: "center" as const };

  const baseTotal = matchingServing ? formatDisplay(matchingServing.base_amount * amount) : null;
  const stepperLabel = matchingServing
    ? `${amount} ${pluralizeUnit(unit, amount)} (${baseTotal} ${baseUnit})`
    : "";

  if (mode === "stepper") {
    return (
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <PressableScale accessibilityLabel="Decrease amount" hitSlop={8} onPress={decrease} style={stepButtonStyle}>
            <Icon name="minus" size={16} color={stepIconColor} />
          </PressableScale>
          <AppText style={stepperValueStyle}>{stepperLabel}</AppText>
          <PressableScale accessibilityLabel="Increase amount" hitSlop={8} onPress={increase} style={stepButtonStyle}>
            <Icon name="plus" size={16} color={stepIconColor} />
          </PressableScale>
        </View>
        <Pressable onPress={enterExactMode} style={(state) => ({ opacity: state.pressed ? 0.6 : 1 })}>
          <AppText muted style={{ textAlign: "center" }}>
            Enter exact amount
          </AppText>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <TextInput
          value={exactText}
          onChangeText={onExactTextChange}
          keyboardType="decimal-pad"
          accessibilityLabel="Amount"
          placeholder="0"
          placeholderTextColor={colors.secondaryLabel}
          style={{
            width: 72,
            textAlign: "right",
            color: colors.label,
            backgroundColor: colors.cardSecondary,
            borderRadius: radius.md,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontFamily: fonts.mono,
          }}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
          {unitOptions.map((option) => {
            const selected = option === exactUnit;
            return (
              <PressableScale
                key={option}
                onPress={() => onExactUnitChange(option)}
                style={{
                  paddingHorizontal: spacing.sm,
                  paddingVertical: 6,
                  borderRadius: radius.md,
                  backgroundColor:
                    variant === "instrument"
                      ? selected
                        ? instrument.accent
                        : instrument.inset
                      : selected
                        ? colors.accent
                        : colors.cardSecondary,
                }}
              >
                <AppText
                  style={{
                    color:
                      variant === "instrument"
                        ? selected
                          ? instrument.accentOn
                          : instrument.ink
                        : selected
                          ? colors.accentForeground
                          : colors.label,
                  }}
                >
                  {option}
                </AppText>
              </PressableScale>
            );
          })}
        </View>
      </View>
    </View>
  );
}
