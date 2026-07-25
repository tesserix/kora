import { useState } from "react";
import { Share, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useSendFriendRequest, useMyFriendCode } from "@/api/hooks";
import { useTheme } from "@/theme";

interface AddFriendSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function AddFriendSheet({ visible, onClose }: AddFriendSheetProps) {
  const { colors, fonts, radius } = useTheme();
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const send = useSendFriendRequest();
  const myCode = useMyFriendCode();

  const onSubmit = () => {
    const v = value.trim();
    if (!v) {
      setErr("Enter a friend code or email.");
      return;
    }
    setErr(null);
    const input = v.includes("@") ? { email: v } : { code: v };
    send.mutate(input, {
      onSuccess: () => {
        setValue("");
        onClose();
      },
      onError: (e: unknown) => {
        const msg = e instanceof Error ? e.message : "";
        setErr(msg || "Couldn't send request. Try again.");
      },
    });
  };

  const shareCode = () => {
    if (myCode.data) Share.share({ message: myCode.data.link }).catch(() => {});
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>Add a friend</Overline>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Friend code or email"
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel="Friend code or email"
          style={{ marginTop: 12, fontSize: 16, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12 }}
        />
        {err ? <AppText style={{ color: colors.destructive, marginTop: 10 }}>{err}</AppText> : null}
        <Button title="Send request" onPress={onSubmit} disabled={send.isPending} style={{ marginTop: 14 }} />

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 22 }} />

        <Overline>Your code</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
          <AppText style={{ fontSize: 20, fontFamily: fonts.mono, letterSpacing: 2 }}>
            {myCode.data?.code ?? "········"}
          </AppText>
          <Button title="Share" onPress={shareCode} variant="ghost" disabled={!myCode.data} />
        </View>
      </View>
    </Sheet>
  );
}
