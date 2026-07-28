import { useState } from "react";
import { ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Overline } from "@/components/Overline";
import { GroupedSection, Row } from "@/components/GroupedList";
import { AppText } from "@/components/Text";
import { RemindersSection } from "@/components/settings/RemindersSection";
import { CustomReminderSheet } from "@/components/reminders/CustomReminderSheet";
import { useCustomReminders } from "@/reminders/useCustomReminders";
import { MAX_CUSTOM_REMINDERS, type CustomReminder, type Weekday } from "@/reminders/customPrefs";
import { useTheme } from "@/theme";

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

export default function Reminders() {
  const insets = useSafeAreaInsets();
  const { colors, spacing } = useTheme();
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
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      >
        <ScreenHeader title="Reminders" onBack={() => router.back()} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <RemindersSection />

          <View>
            <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Custom</Overline>
            <GroupedSection>
              {reminders.map((r) => (
                <Row
                  key={r.id}
                  title={r.label}
                  subtitle={daysSummary(r.days)}
                  detail={fmt(r.hour, r.minute)}
                  onPress={() => openEdit(r)}
                  right={
                    <Switch
                      testID={`custom-switch-${r.id}`}
                      value={r.enabled}
                      onValueChange={(enabled) => toggleReminder(r.id, enabled)}
                      trackColor={{ true: colors.accent, false: colors.muted }}
                    />
                  }
                />
              ))}
              <Row
                title="Add reminder"
                icon={{ name: "bell", tint: colors.accent }}
                onPress={atCap ? undefined : openAdd}
              />
            </GroupedSection>
            {atCap ? (
              <AppText variant="footnote" muted style={{ marginLeft: spacing.md, marginTop: spacing.xs }}>
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
