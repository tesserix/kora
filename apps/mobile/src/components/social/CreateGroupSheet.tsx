import { useState } from "react";
import { TextInput, View } from "react-native";
import { router, type Href } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useCreateGroup, useJoinGroup } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { GroupSummary } from "@/api/types";

interface Props {
  visible: boolean;
  mode: "create" | "join";
  onClose: () => void;
}

export function CreateGroupSheet({ visible, mode, onClose }: Props) {
  const { colors, radius } = useTheme();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateGroup();
  const join = useJoinGroup();
  const isCreate = mode === "create";
  const pending = create.isPending || join.isPending;

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr(isCreate ? "Name your group." : "Enter a group code.");
      return;
    }
    setErr(null);
    const done = (g: GroupSummary) => {
      setValue("");
      onClose();
      router.push(`/group/${g.id}` as Href);
    };
    if (isCreate) create.mutate(v, { onSuccess: done, onError: () => setErr("Couldn't create. Try again.") });
    else join.mutate(v, { onSuccess: done, onError: () => setErr("No group matches that code.") });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{isCreate ? "Create a group" : "Join a group"}</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize={isCreate ? "words" : "characters"}
          autoCorrect={false}
          placeholder={isCreate ? "Group name" : "Group code"}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={isCreate ? "Group name" : "Group code"}
          style={{ marginTop: 12, fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title={isCreate ? "Create group" : "Join group"} onPress={onSubmit} disabled={pending} style={{ marginTop: 14 }} />
      </View>
    </Sheet>
  );
}
