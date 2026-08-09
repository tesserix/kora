import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { useTheme } from "@/theme";
import type { ServingUnit } from "@/units/portion";

interface PortionFieldProps {
  baseUnit: "g" | "ml";
  servingUnits: ServingUnit[];
  amount: number;
  unit: string;
  onChange: (amount: number, unit: string) => void;
}

// Display-only rounding for the "(16.5 g)" stepper hint. This figure never
// leaves the component — the server resolves the authoritative grams from
// the reported (amount, unit) pair.
function formatDisplay(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

export function PortionField({ baseUnit, servingUnits, amount, unit, onChange }: PortionFieldProps) {
  const { colors, spacing, radius, fonts } = useTheme();

  const matchingServing = servingUnits.find((s) => s.name === unit);

  const [mode, setMode] = useState<"stepper" | "exact">(matchingServing ? "stepper" : "exact");
  const [servingAmount, setServingAmount] = useState(amount);
  const [exactUnit, setExactUnit] = useState<string>(matchingServing ? baseUnit : unit);
  const [exactText, setExactText] = useState<string>(matchingServing ? "" : String(amount));

  const unitOptions = [baseUnit, ...servingUnits.map((s) => s.name)];

  const increase = () => {
    const next = servingAmount + 1;
    setServingAmount(next);
    onChange(next, unit);
  };

  const decrease = () => {
    // Zero servings is not a portion, so decrementing at 1 does nothing.
    if (servingAmount <= 1) return;
    const next = servingAmount - 1;
    setServingAmount(next);
    onChange(next, unit);
  };

  const enterExactMode = () => setMode("exact");

  const reportExact = (text: string, selectedUnit: string) => {
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0) {
      onChange(parsed, selectedUnit);
    }
  };

  const onExactTextChange = (text: string) => {
    setExactText(text);
    reportExact(text, exactUnit);
  };

  const onExactUnitChange = (selectedUnit: string) => {
    setExactUnit(selectedUnit);
    reportExact(exactText, selectedUnit);
  };

  const stepButtonStyle = {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.cardSecondary,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };

  const baseTotal = matchingServing ? formatDisplay(matchingServing.base_amount * servingAmount) : null;
  const stepperLabel = matchingServing
    ? `${servingAmount} ${unit}${servingAmount === 1 ? "" : "s"} (${baseTotal} ${baseUnit})`
    : "";

  if (mode === "stepper" && matchingServing) {
    return (
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable accessibilityLabel="Decrease amount" hitSlop={8} onPress={decrease} style={stepButtonStyle}>
            <Icon name="minus" size={16} color={colors.label} />
          </Pressable>
          <AppText style={{ flex: 1, textAlign: "center" }}>{stepperLabel}</AppText>
          <Pressable accessibilityLabel="Increase amount" hitSlop={8} onPress={increase} style={stepButtonStyle}>
            <Icon name="plus" size={16} color={colors.label} />
          </Pressable>
        </View>
        <Pressable onPress={enterExactMode}>
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
              <Pressable
                key={option}
                onPress={() => onExactUnitChange(option)}
                style={{
                  paddingHorizontal: spacing.sm,
                  paddingVertical: 6,
                  borderRadius: radius.md,
                  backgroundColor: selected ? colors.accent : colors.cardSecondary,
                }}
              >
                <AppText style={{ color: selected ? colors.accentForeground : colors.label }}>{option}</AppText>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
