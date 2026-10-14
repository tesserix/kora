import { StyleSheet, View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

// A hairline rule broken by "or", between a form and the provider buttons.
export function OrDivider() {
  const { instrument, spacing } = useTheme();
  const rule = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: instrument.glassBorder };
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginVertical: spacing.xs }}
    >
      <View style={rule} />
      <AppText style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1.98, color: instrument.mut }}>or</AppText>
      <View style={rule} />
    </View>
  );
}
