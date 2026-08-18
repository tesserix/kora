import { StyleSheet, TextInput, View } from "react-native";
import { Icon } from "@/components/Icon";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export function AskInput({
  value,
  disabled,
  pending,
  onChangeText,
  onSend,
}: {
  value: string;
  disabled: boolean;
  pending: boolean;
  onChangeText: (value: string) => void;
  onSend: () => void;
}) {
  const { instrument, fonts } = useTheme();
  const sendDisabled = disabled || pending || value.trim().length === 0;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: 8,
        borderRadius: 20,
        padding: 6,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.glassBorder,
      }}
    >
      <TextInput
        accessibilityLabel="Ask Otto a nutrition question"
        value={value}
        onChangeText={onChangeText}
        placeholder="Ask about your nutrition…"
        placeholderTextColor={instrument.mut}
        multiline
        maxLength={4000}
        returnKeyType="send"
        blurOnSubmit={false}
        onSubmitEditing={() => {
          if (!sendDisabled) onSend();
        }}
        style={{ flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: 10, paddingVertical: 10, color: instrument.ink, fontFamily: fonts.rounded }}
      />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Send question"
        accessibilityState={{ disabled: sendDisabled }}
        disabled={sendDisabled}
        haptic="impactLight"
        onPress={onSend}
        style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: instrument.accent, opacity: sendDisabled ? 0.45 : 1 }}
      >
        <Icon name="arrow-up" size={18} color={instrument.accentOn} />
      </PressableScale>
    </View>
  );
}
