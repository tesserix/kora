import { useState } from "react";
import { Platform, View, Switch, Pressable } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
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
  const [draft, setDraft] = useState<Date | null>(null);

  const openPicker = (slot: MealSlot): void => {
    setDraft(new Date(2000, 0, 1, prefs[slot].hour, prefs[slot].minute));
    setEditing(slot);
  };

  const applyDraft = (): void => {
    const slot = editing;
    const date = draft;
    setEditing(null);
    setDraft(null);
    if (slot && date) setSlot(slot, { ...prefs[slot], hour: date.getHours(), minute: date.getMinutes() });
  };

  const cancel = (): void => {
    setEditing(null);
    setDraft(null);
  };

  const onAndroidChange = (event: DateTimePickerEvent, date?: Date): void => {
    const slot = editing;
    setEditing(null);
    setDraft(null);
    if (event.type === "set" && date && slot) {
      setSlot(slot, { ...prefs[slot], hour: date.getHours(), minute: date.getMinutes() });
    }
  };

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
              <Pressable accessibilityLabel={`${LABEL[slot]} time`} onPress={() => openPicker(slot)} disabled={!p.enabled}>
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
      {Platform.OS === "ios" ? (
        <Sheet visible={editing !== null} onClose={cancel}>
          <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
            <Overline>{editing ? `${LABEL[editing]} reminder` : ""}</Overline>
            {draft ? (
              <DateTimePicker
                mode="time"
                display="spinner"
                value={draft}
                onChange={(_e, date) => {
                  if (date) setDraft(date);
                }}
                textColor={colors.label}
              />
            ) : null}
            <Button title="Done" onPress={applyDraft} />
          </View>
        </Sheet>
      ) : editing !== null ? (
        <DateTimePicker mode="time" value={draft ?? new Date(2000, 0, 1, prefs[editing].hour, prefs[editing].minute)} onChange={onAndroidChange} />
      ) : null}
    </View>
  );
}
