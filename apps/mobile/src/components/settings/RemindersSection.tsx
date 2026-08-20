import { useState } from "react";
import { Platform, View, Pressable } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { ToggleSwitch } from "@/components/ToggleSwitch";
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
  const { instrument, spacing } = useTheme();
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
            // The row WRAPS, and the time + switch are grouped so they drop to
            // line two TOGETHER (kora#274). Before this the row was three flat
            // siblings and the label carried `flex: 1` — i.e. `flexShrink: 1`
            // against two siblings on RN's default `flexShrink: 0`. So the
            // label absorbed the whole overflow alone: measured at
            // accessibility-extra-large, "Breakfast" got a 139pt box for a word
            // that wants ~200pt at 45pt type, and broke as "Breakf" / "ast".
            // That is the kora#263 failure exactly — a shrink box narrowed past
            // the word it holds — not the largeTitle over-scale that the two
            // ScreenHeader cases in the same issue turned out to be.
            //
            // `flexGrow: 1, flexShrink: 0` on the label is the kora#264 recipe
            // and for the same reason: with `flexShrink: 1` yoga collapses the
            // label when it decides where the line breaks, so the line never
            // breaks. With shrink off the label measures its own type, the row
            // sees 200 + 149 + 63 + gaps against a 400pt inner width, and the
            // controls wrap. iOS does this itself — Settings > Accessibility at
            // AXL drops the "Hover Text" row's "Off" detail to its own line
            // rather than squeezing the label.
            //
            // At `medium` nothing moves: ~72pt label + ~55pt time + 51pt switch
            // + gaps fits one line inside 400pt, and only "Breakfast" was ever
            // long enough to break — "Lunch" measured 125pt on one line
            // untouched. Verified by screenshot at both sizes.
            <View
              key={slot}
              style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", minHeight: 44, paddingHorizontal: spacing.md, rowGap: spacing.xs, columnGap: spacing.sm }}
            >
              <AppText style={{ flexGrow: 1, flexShrink: 0, fontSize: 17, fontWeight: "600", color: instrument.ink }}>{LABEL[slot]}</AppText>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Pressable accessibilityLabel={`${LABEL[slot]} time`} onPress={() => openPicker(slot)} disabled={!p.enabled} style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}>
                  <AppText style={{ fontSize: 15, color: instrument.mut, opacity: p.enabled ? 1 : 0.4 }}>{fmt(p.hour, p.minute)}</AppText>
                </Pressable>
                <ToggleSwitch
                  testID={`reminder-switch-${slot}`}
                  value={p.enabled}
                  onValueChange={(enabled) => setSlot(slot, { ...p, enabled })}
                />
              </View>
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
                textColor={instrument.ink}
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
