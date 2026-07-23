import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export default function Index() {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.background,
        justifyContent: "center",
        padding: spacing.lg,
        gap: spacing.md,
      }}
    >
      <AppText variant="h1">Kora</AppText>
      <AppText muted>Nutrition that feels like conversation.</AppText>
      <Card>
        <AppText variant="h3">Today</AppText>
        <AppText muted>Nothing logged yet.</AppText>
      </Card>
      <Button title="Get started" onPress={() => {}} />
    </View>
  );
}
