import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useAddWeight } from "@/api/hooks";
import { useTheme } from "@/theme";
import { lbFromKg, parseWeightToKg, useUnits, weightUnitLabel, type UnitSystem } from "@/units";

interface WeightLogSheetProps {
  visible: boolean;
  initialKg: number;
  onClose: () => void;
}

function seedText(initialKg: number, system: UnitSystem): string {
  if (initialKg <= 0) return "";
  const value = system === "imperial" ? lbFromKg(initialKg) : initialKg;
  return String(value);
}

export function WeightLogSheet({ visible, initialKg, onClose }: WeightLogSheetProps) {
  const { colors, fonts, radius } = useTheme();
  const { system } = useUnits();
  const [text, setText] = useState(seedText(initialKg, system));
  const [err, setErr] = useState<string | null>(null);
  const addWeight = useAddWeight();
  const unit = weightUnitLabel(system);
  const accessibilityLabel = system === "imperial" ? "Weight in pounds" : "Weight in kilograms";

  useEffect(() => {
    if (visible) {
      setText(seedText(initialKg, system));
      setErr(null);
    }
  }, [visible, initialKg, system]);

  const onSave = () => {
    const kg = parseWeightToKg(text, system);
    if (kg === null) {
      setErr(`Enter a weight in ${unit}.`);
      return;
    }
    setErr(null);
    addWeight.mutate(
      { weight_kg: kg },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't save. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Log weight</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, marginBottom: 18 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            keyboardType="decimal-pad"
            placeholder="0.0"
            placeholderTextColor={colors.secondaryLabel}
            accessibilityLabel={accessibilityLabel}
            style={{ flex: 1, fontSize: 28, fontFamily: fonts.mono, color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 }}
          />
          <AppText muted style={{ fontSize: 16, fontFamily: fonts.mono }}>{unit}</AppText>
        </View>
        {err ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{err}</AppText> : null}
        <Button title="Save" onPress={onSave} disabled={addWeight.isPending} />
      </View>
    </Sheet>
  );
}
