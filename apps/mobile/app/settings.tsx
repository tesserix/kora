import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { Card } from "@/components/Card";
import { Segmented } from "@/components/Segmented";
import { useUnits, type UnitSystem } from "@/units";
import { useTheme } from "@/theme";

const UNIT_OPTIONS = [
  { key: "metric", label: "Metric" },
  { key: "imperial", label: "Imperial" },
];

export default function SettingsScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { system, setSystem } = useUnits();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Preferences" title="Settings" onBack={() => router.back()} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <Card variant="elevated">
            <AppText variant="footnote" muted style={{ marginBottom: spacing.sm }}>
              Units
            </AppText>
            <Segmented
              options={UNIT_OPTIONS}
              value={system}
              onChange={(key) => setSystem(key as UnitSystem)}
            />
            <AppText variant="caption" muted style={{ marginTop: spacing.sm }}>
              Weight and height display.
            </AppText>
          </Card>
        </View>
      </ScrollView>
    </View>
  );
}
