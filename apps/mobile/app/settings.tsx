import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { Segmented } from "@/components/Segmented";
import { GroupedSection, Row } from "@/components/GroupedList";
import { useUnits, type UnitSystem } from "@/units";
import { useTheme } from "@/theme";

const UNIT_OPTIONS = [
  { key: "metric", label: "Metric" },
  { key: "imperial", label: "Imperial" },
];

export default function SettingsScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { system, setSystem } = useUnits();

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Preferences" title="Settings" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <GlassPanel radius={22} style={{ padding: spacing.md }}>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginBottom: spacing.sm }}>
              Units
            </AppText>
            <Segmented
              options={UNIT_OPTIONS}
              value={system}
              onChange={(key) => setSystem(key as UnitSystem)}
            />
            <AppText style={{ fontSize: 11, color: instrument.mut, marginTop: spacing.sm }}>
              Weight and height display.
            </AppText>
          </GlassPanel>
          <GroupedSection>
            <Row
              title="Reminders"
              icon={{ name: "bell", tint: instrument.mut }}
              chevron
              accessibilityLabel="Reminders"
              onPress={() => router.push("/reminders" as Href)}
            />
          </GroupedSection>
        </View>
      </ScrollView>
    </View>
  );
}
