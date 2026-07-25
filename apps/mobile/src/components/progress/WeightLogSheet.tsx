import { useState } from "react";
import { TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useAddWeight } from "@/api/hooks";
import { useTheme } from "@/theme";

interface WeightLogSheetProps {
  visible: boolean;
  initialKg: number;
  onClose: () => void;
}

export function WeightLogSheet({ visible, initialKg, onClose }: WeightLogSheetProps) {
  const { colors, fonts } = useTheme();
  const [text, setText] = useState(initialKg > 0 ? String(initialKg) : "");
  const [err, setErr] = useState<string | null>(null);
  const addWeight = useAddWeight();

  const onSave = () => {
    const kg = parseFloat(text);
    if (!Number.isFinite(kg) || kg <= 0) {
      setErr("Enter a weight in kg.");
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
            placeholderTextColor={colors.mutedForeground}
            accessibilityLabel="Weight in kilograms"
            style={{ flex: 1, fontSize: 28, fontFamily: fonts.mono, color: colors.foreground, borderBottomWidth: 1, borderBottomColor: colors.border, paddingVertical: 8 }}
          />
          <AppText muted style={{ fontSize: 16, fontFamily: fonts.mono }}>kg</AppText>
        </View>
        {err ? <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{err}</AppText> : null}
        <Button title="Save" onPress={onSave} disabled={addWeight.isPending} />
      </View>
    </Sheet>
  );
}
