import { useState } from "react";
import { View, Switch, Pressable } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { useReminderPrefs } from "@/reminders/useReminderPrefs";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";

const SLOTS: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];
const LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

export function RemindersSection() {
  const { prefs, setSlot } = useReminderPrefs();
  const { colors, spacing } = useTheme();
  const [editing, setEditing] = useState<MealSlot | null>(null);

  return (
    <View style={{ marginTop: spacing.md }}>
      <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Reminders</Overline>
      <GroupedSection>
        {SLOTS.map((slot) => {
          const p = prefs[slot];
          return (
            <View
              key={slot}
              style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, gap: spacing.sm }}
            >
              <AppText variant="headline" style={{ flex: 1 }}>{LABEL[slot]}</AppText>
              <Pressable accessibilityLabel={`${LABEL[slot]} time`} onPress={() => setEditing(slot)} disabled={!p.enabled}>
                <AppText variant="subheadline" muted style={{ opacity: p.enabled ? 1 : 0.4 }}>{fmt(p.hour, p.minute)}</AppText>
              </Pressable>
              <Switch
                testID={`reminder-switch-${slot}`}
                value={p.enabled}
                onValueChange={(enabled) => setSlot(slot, { ...p, enabled })}
                trackColor={{ true: colors.accent, false: colors.muted }}
              />
            </View>
          );
        })}
      </GroupedSection>
      {editing ? (
        <DateTimePicker
          mode="time"
          value={new Date(2000, 0, 1, prefs[editing].hour, prefs[editing].minute)}
          onChange={(_e, date) => {
            const slot = editing;
            setEditing(null);
            if (date) setSlot(slot, { ...prefs[slot], hour: date.getHours(), minute: date.getMinutes() });
          }}
        />
      ) : null}
    </View>
  );
}
