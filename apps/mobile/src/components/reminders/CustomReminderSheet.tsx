import { useEffect, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { useTheme } from "@/theme";
import { WeekdayPicker } from "@/components/reminders/WeekdayPicker";
import { NEW_REMINDER_DEFAULT, type CustomReminder, type Weekday } from "@/reminders/customPrefs";

const PRESETS = ["Drink water", "Workout", "Vitamins", "Weigh-in"];

function fmt(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

interface Props {
  visible: boolean;
  editing: CustomReminder | null;
  onClose: () => void;
  onSave: (draft: Omit<CustomReminder, "id">, id: string | null) => void;
  onDelete: (id: string) => void;
}

export function CustomReminderSheet({ visible, editing, onClose, onSave, onDelete }: Props) {
  const { instrument, spacing, radius } = useTheme();
  const [label, setLabel] = useState("");
  const [hour, setHour] = useState(NEW_REMINDER_DEFAULT.hour);
  const [minute, setMinute] = useState(NEW_REMINDER_DEFAULT.minute);
  const [days, setDays] = useState<Weekday[]>(NEW_REMINDER_DEFAULT.days);
  const [showPicker, setShowPicker] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (editing) {
      setLabel(editing.label);
      setHour(editing.hour);
      setMinute(editing.minute);
      setDays(editing.days);
    } else {
      setLabel("");
      setHour(NEW_REMINDER_DEFAULT.hour);
      setMinute(NEW_REMINDER_DEFAULT.minute);
      setDays(NEW_REMINDER_DEFAULT.days);
    }
    setErr(null);
    setShowPicker(false);
  }, [visible, editing]);

  const save = () => {
    const trimmed = label.trim();
    if (!trimmed) { setErr("Enter a label."); return; }
    if (days.length === 0) { setErr("Pick at least one day."); return; }
    onSave({ label: trimmed, hour, minute, days, enabled: editing ? editing.enabled : true }, editing ? editing.id : null);
  };

  const chip = (selected: boolean) => ({
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: selected ? instrument.accent : instrument.inset,
  });

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline>{editing ? "Edit reminder" : "New reminder"}</Overline>

        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="Reminder label"
          placeholderTextColor={instrument.mut}
          accessibilityLabel="Reminder label"
          style={{ fontSize: 20, color: instrument.ink, backgroundColor: instrument.inset, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 12, marginTop: spacing.md }}
        />

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm }}>
          {PRESETS.map((p) => (
            <Pressable key={p} onPress={() => setLabel(p)} style={chip(false)}>
              <AppText style={{ fontSize: 13, color: instrument.mut }}>{p}</AppText>
            </Pressable>
          ))}
        </View>

        <Pressable accessibilityLabel="Reminder time" onPress={() => setShowPicker((s) => !s)} style={{ marginTop: spacing.md, flexDirection: "row", justifyContent: "space-between" }}>
          <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink }}>Time</AppText>
          <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.accent }}>{fmt(hour, minute)}</AppText>
        </Pressable>
        {showPicker ? (
          <DateTimePicker
            mode="time"
            display={Platform.OS === "ios" ? "spinner" : "default"}
            value={new Date(2000, 0, 1, hour, minute)}
            textColor={instrument.ink}
            onChange={(_e, date) => {
              if (Platform.OS !== "ios") setShowPicker(false);
              if (date) { setHour(date.getHours()); setMinute(date.getMinutes()); }
            }}
          />
        ) : null}

        <WeekdayPicker days={days} onChange={setDays} />

        {err ? <AppText style={{ color: instrument.danger, marginTop: spacing.sm }}>{err}</AppText> : null}

        <View style={{ marginTop: spacing.lg }}>
          <Button title="Save" onPress={save} />
        </View>
        {editing ? (
          <Pressable onPress={() => onDelete(editing.id)} style={{ marginTop: spacing.md, alignItems: "center" }}>
            <AppText style={{ color: instrument.danger }}>Delete reminder</AppText>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}
