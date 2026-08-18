import { StyleSheet, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

export function SupportCard() {
  const { instrument, spacing } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel="A little extra support. If food or body concerns feel difficult, you do not have to handle them alone."
      style={{
        margin: spacing.md,
        padding: spacing.md,
        borderRadius: 18,
        backgroundColor: instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.teal,
        flexDirection: "row",
        gap: spacing.sm,
      }}
    >
      <Icon name="heart" size={20} color={instrument.teal} />
      <View style={{ flex: 1 }}>
        <AppText style={{ color: instrument.ink, fontWeight: "700" }}>A little extra support</AppText>
        <AppText style={{ color: instrument.mut, fontSize: 13, lineHeight: 19, marginTop: 3 }}>
          If food or body concerns feel difficult, you don&apos;t have to handle them alone. Consider talking with someone you trust or a qualified health professional.
        </AppText>
      </View>
    </View>
  );
}
