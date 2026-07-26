import { useEffect, useState } from "react";
import { TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useRenameGroup } from "@/api/hooks";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  groupId: string;
  currentName: string;
  onClose: () => void;
}

export function RenameGroupSheet({ visible, groupId, currentName, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [value, setValue] = useState(currentName);
  const [err, setErr] = useState<string | null>(null);
  const rename = useRenameGroup();

  // Seed (and re-seed) the input from the current name whenever the sheet opens.
  useEffect(() => {
    if (visible) {
      setValue(currentName);
      setErr(null);
    }
  }, [visible, currentName]);

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr("Name your group.");
      return;
    }
    setErr(null);
    rename.mutate(
      { groupId, name: v },
      { onSuccess: () => onClose(), onError: () => setErr("Couldn't rename. Try again.") },
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Rename group</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize="words"
          autoCorrect={false}
          placeholder="Group name"
          placeholderTextColor={colors.secondaryLabel}
          accessibilityLabel="Group name"
          style={{ marginTop: 12, fontSize: 16, color: colors.label, backgroundColor: colors.cardSecondary, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title="Save" onPress={onSubmit} disabled={rename.isPending} style={{ marginTop: 14 }} />
      </View>
    </Sheet>
  );
}
