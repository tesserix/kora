import { View } from "react-native";
import { AppText } from "@/components/Text";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export default function ConfigMissing() {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Almost there</AppText>
      <Card>
        <AppText variant="h3">Firebase isn&apos;t configured</AppText>
        <AppText muted>
          Set EXPO_PUBLIC_FIREBASE_API_KEY, AUTH_DOMAIN, PROJECT_ID, and APP_ID in
          apps/mobile/.env, then reload the app.
        </AppText>
      </Card>
    </View>
  );
}
