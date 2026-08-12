import { useEffect, useRef, useState, type ReactElement } from "react";
import { Platform, View, Switch, Pressable } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { GroupedSection } from "@/components/GroupedList";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { useToast } from "@/components/Toast";
import { WeekdayPicker } from "@/components/reminders/WeekdayPicker";
import { DEFAULT_WEIGHT_PREF, loadWeightPref, saveWeightPref, type WeightReminderPref } from "@/reminders/weightPrefs";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";
import { ensureNotificationAccess, notifyNotificationAccessDenied } from "@/reminders/notificationAccess";
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
// Every committed change is persisted then reconciled with no argument: the
// user is editing the SCHEDULE, not recording a weigh-in, so the reconcile
// looks up the real last weigh-in itself. Passing a placeholder `null` here
// used to re-arm a reminder for a day already logged — weigh in at 06:40, add
// a day to the chips at 06:50, get nagged at 07:00.
export function WeightReminderSection(): ReactElement {
  const { instrument, spacing } = useTheme();
  const [pref, setPref] = useState<WeightReminderPref>(DEFAULT_WEIGHT_PREF);
  const prefRef = useRef<WeightReminderPref>(DEFAULT_WEIGHT_PREF);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Date | null>(null);
  const [daysError, setDaysError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    loadWeightPref().then((p) => {
      prefRef.current = p;
      setPref(p);
    });
  }, []);

  // commit applies a partial change (the field the caller is editing) rather
  // than a whole new object. Two edits can be in flight at once — e.g. a day
  // change fired while the enabling permission dialog is still pending — and
  // `next` is built from `prefRef.current` AFTER the permission await
  // resolves, not from a pre-await snapshot, so a slower call can never
  // clobber a faster one. This mirrors useReminderPrefs.setSlot's
  // recompute-after-await safeguard.
  //
  // Permission is only (re-)checked on the off→on transition: editing the
  // time or days of an already-enabled reminder can't need a fresh prompt.
  const commit = (patch: Partial<WeightReminderPref>): void => {
    void (async () => {
      const turningOn = patch.enabled === true && !prefRef.current.enabled;
      if (turningOn) {
        const access = await ensureNotificationAccess();
        if (!access.granted) {
          // denied → do not enable; force a fresh object reference so the
          // controlled Switch re-renders back to its current (unchanged) state
          setPref({ ...prefRef.current });
          notifyNotificationAccessDenied(toast, access.blocked);
          return;
        }
      }
      const next = { ...prefRef.current, ...patch };
      prefRef.current = next;
      setPref(next);
      await saveWeightPref(next);
      await reconcileWeightReminder();
    })().catch((err) => console.warn("reminders: weight reminder commit failed", err));
  };

  // onDaysChange refuses an empty selection instead of committing it. With no
  // days selected nextWeightReminderAt returns null, so nothing is ever
  // scheduled while the switch still reads ON — a dead state with no signal to
  // the user. CustomReminderSheet guards the same case with the same wording.
  const onDaysChange = (days: WeightReminderPref["days"]): void => {
    if (days.length === 0) {
      setDaysError("Pick at least one day.");
      return;
    }
    setDaysError(null);
    commit({ days });
  };

  const openPicker = (): void => {
    setDraft(new Date(2000, 0, 1, pref.hour, pref.minute));
    setEditing(true);
  };

  const applyDraft = (): void => {
    const date = draft;
    setEditing(false);
    setDraft(null);
    if (date) commit({ hour: date.getHours(), minute: date.getMinutes() });
  };

  const cancel = (): void => {
    setEditing(false);
    setDraft(null);
  };

  const onAndroidChange = (event: DateTimePickerEvent, date?: Date): void => {
    setEditing(false);
    setDraft(null);
    if (event.type === "set" && date) {
      commit({ hour: date.getHours(), minute: date.getMinutes() });
    }
  };

  return (
    <View style={{ marginTop: spacing.md }}>
      <Overline style={{ marginLeft: spacing.md, marginBottom: spacing.xs }}>Weight check-in</Overline>
      <GroupedSection>
        <View
          style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, gap: spacing.sm }}
        >
          {/* The section header already says "Weight check-in" — repeating it
              here doubled the phrase and wrapped the row to two lines. */}
          <AppText style={{ flex: 1, fontSize: 17, fontWeight: "600", color: instrument.ink }}>
            Reminder
          </AppText>
          <Pressable accessibilityLabel="Weight check-in time" onPress={openPicker} disabled={!pref.enabled}>
            <AppText style={{ fontSize: 15, color: instrument.mut, opacity: pref.enabled ? 1 : 0.4 }}>
              {fmt(pref.hour, pref.minute)}
            </AppText>
          </Pressable>
          <Switch
            accessibilityLabel="Weight check-in reminder"
            value={pref.enabled}
            onValueChange={(enabled) => commit({ enabled })}
            trackColor={{ true: instrument.accent, false: instrument.inset }}
          />
        </View>
      </GroupedSection>
      <WeekdayPicker days={pref.days} onChange={onDaysChange} />
      {daysError ? (
        <AppText style={{ color: instrument.danger, marginLeft: spacing.md, marginTop: spacing.xs }}>
          {daysError}
        </AppText>
      ) : null}
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
                textColor={instrument.ink}
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
