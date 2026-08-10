import { useEffect, useRef, useState, type ReactElement } from "react";
import { Platform, View, Switch, Pressable } from "react-native";
import * as Notifications from "expo-notifications";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { WeekdayPicker } from "@/components/reminders/WeekdayPicker";
import { DEFAULT_WEIGHT_PREF, loadWeightPref, saveWeightPref, type WeightReminderPref } from "@/reminders/weightPrefs";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { useTheme } from "@/theme";

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

// WeightReminderSection lets the user turn the weight check-in reminder on,
// set its time, and pick which weekdays it fires. It mirrors RemindersSection's
// permission-and-persistence shape: enabling checks/requests OS notification
// permission first, and denial reverts the toggle by forcing a fresh object
// reference into state so the controlled Switch re-renders back to off.
//
// Every committed change is persisted then reconciled with `lastWeighedAt:
// null` — correct here because the user is editing the SCHEDULE, not
// recording a weigh-in; the app's foreground pass supplies the real date.
export function WeightReminderSection(): ReactElement {
  const { colors, spacing } = useTheme();
  const [pref, setPref] = useState<WeightReminderPref>(DEFAULT_WEIGHT_PREF);
  const prefRef = useRef<WeightReminderPref>(DEFAULT_WEIGHT_PREF);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Date | null>(null);

  useEffect(() => {
    loadWeightPref().then((p) => {
      prefRef.current = p;
      setPref(p);
    });
  }, []);

  const commit = (next: WeightReminderPref): void => {
    void (async () => {
      if (next.enabled) {
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted) {
          const req = await Notifications.requestPermissionsAsync();
          if (!req.granted) {
            // denied → do not enable; force a fresh object reference so the
            // controlled Switch re-renders back to its current (unchanged) state
            setPref({ ...prefRef.current });
            return;
          }
        }
      }
      prefRef.current = next;
      setPref(next);
      await saveWeightPref(next);
      await reconcileWeightReminder(null);
    })();
  };

  const openPicker = (): void => {
    setDraft(new Date(2000, 0, 1, pref.hour, pref.minute));
    setEditing(true);
  };

  const applyDraft = (): void => {
    const date = draft;
    setEditing(false);
    setDraft(null);
    if (date) commit({ ...prefRef.current, hour: date.getHours(), minute: date.getMinutes() });
  };

  const cancel = (): void => {
    setEditing(false);
    setDraft(null);
  };

  const onAndroidChange = (event: DateTimePickerEvent, date?: Date): void => {
    setEditing(false);
    setDraft(null);
    if (event.type === "set" && date) {
      commit({ ...prefRef.current, hour: date.getHours(), minute: date.getMinutes() });
    }
  };

  return (
    <View style={{ marginTop: spacing.md }}>
      <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Weight check-in</Overline>
      <GroupedSection>
        <View
          style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, gap: spacing.sm }}
        >
          <AppText variant="headline" style={{ flex: 1 }}>
            Weight check-in reminder
          </AppText>
          <Pressable accessibilityLabel="Weight check-in time" onPress={openPicker} disabled={!pref.enabled}>
            <AppText variant="subheadline" muted style={{ opacity: pref.enabled ? 1 : 0.4 }}>
              {fmt(pref.hour, pref.minute)}
            </AppText>
          </Pressable>
          <Switch
            accessibilityLabel="Weight check-in reminder"
            value={pref.enabled}
            onValueChange={(enabled) => commit({ ...prefRef.current, enabled })}
            trackColor={{ true: colors.accent, false: colors.muted }}
          />
        </View>
      </GroupedSection>
      <WeekdayPicker days={pref.days} onChange={(days) => commit({ ...prefRef.current, days })} />
      {Platform.OS === "ios" ? (
        <Sheet visible={editing} onClose={cancel}>
          <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
            <Overline>Weight check-in reminder</Overline>
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
      ) : editing ? (
        <DateTimePicker mode="time" value={draft ?? new Date(2000, 0, 1, pref.hour, pref.minute)} onChange={onAndroidChange} />
      ) : null}
    </View>
  );
}
