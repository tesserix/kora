import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { engravedStyle } from "@/components/instrument/typography";
import { GroupedSection, Row } from "@/components/GroupedList";
import { ToggleSwitch } from "@/components/ToggleSwitch";
import { RemindersSection } from "@/components/settings/RemindersSection";
import { WeightReminderSection } from "@/components/settings/WeightReminderSection";
import { CustomReminderSheet } from "@/components/reminders/CustomReminderSheet";
import { useCustomReminders } from "@/reminders/useCustomReminders";
import { MAX_CUSTOM_REMINDERS, type CustomReminder, type Weekday } from "@/reminders/customPrefs";
import { useUnits, type UnitSystem } from "@/units";
import { useTheme } from "@/theme";

const UNIT_OPTIONS = [
  { key: "metric", label: "Metric" },
  { key: "imperial", label: "Imperial" },
];

const SHORT: Record<Weekday, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

// daysSummary renders a compact human label for a reminder's weekdays.
function daysSummary(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size >= 7) return "Every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d as Weekday))) return "Weekdays";
  return [...days].sort((a, b) => a - b).map((d) => SHORT[d]).join(", ");
}

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export default function SettingsScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { system, setSystem } = useUnits();
  const { reminders, addReminder, updateReminder, removeReminder, toggleReminder } = useCustomReminders();
  const [editing, setEditing] = useState<CustomReminder | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const openAdd = (): void => {
    setEditing(null);
    setSheetOpen(true);
  };
  const openEdit = (r: CustomReminder): void => {
    setEditing(r);
    setSheetOpen(true);
  };
  const atCap = reminders.length >= MAX_CUSTOM_REMINDERS;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Preferences" title="Settings" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Units
            </AppText>
            <GlassPanel radius={22} style={{ padding: spacing.md }}>
              <SegmentedGlass
                options={UNIT_OPTIONS}
                value={system}
                onChange={(key) => setSystem(key as UnitSystem)}
              />
            </GlassPanel>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md, marginTop: spacing.xs }}>
              Weight and height display.
            </AppText>
          </View>

          <RemindersSection />
          <WeightReminderSection />

          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Custom
            </AppText>
            <GroupedSection>
              {reminders.map((r) => (
                <Row
                  key={r.id}
                  title={r.label}
                  subtitle={daysSummary(r.days)}
                  detail={fmt(r.hour, r.minute)}
                  onPress={() => openEdit(r)}
                  right={
                    <ToggleSwitch
                      testID={`custom-switch-${r.id}`}
                      value={r.enabled}
                      onValueChange={(enabled) => toggleReminder(r.id, enabled)}
                    />
                  }
                />
              ))}
              <Row
                title="Add reminder"
                icon={{ name: "bell", tint: instrument.mut }}
                onPress={atCap ? undefined : openAdd}
              />
            </GroupedSection>
            {atCap ? (
              <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md, marginTop: spacing.xs }}>
                You’ve reached the {MAX_CUSTOM_REMINDERS}-reminder limit.
              </AppText>
            ) : null}
          </View>
        </View>
      </ScrollView>

      <CustomReminderSheet
        visible={sheetOpen}
        editing={editing}
        onClose={() => setSheetOpen(false)}
        onSave={(draft, id) => {
          setSheetOpen(false);
          if (id) updateReminder({ ...draft, id });
          else addReminder(draft);
        }}
        onDelete={(id) => {
          setSheetOpen(false);
          removeReminder(id);
        }}
      />
    </View>
  );
}
