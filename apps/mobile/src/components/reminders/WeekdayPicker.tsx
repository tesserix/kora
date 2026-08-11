import { Pressable, View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";
import type { Weekday } from "@/reminders/customPrefs";

const DAY_CHIPS: { day: Weekday; label: string }[] = [
  { day: 0, label: "S" }, { day: 1, label: "M" }, { day: 2, label: "T" },
  { day: 3, label: "W" }, { day: 4, label: "T" }, { day: 5, label: "F" }, { day: 6, label: "S" },
];
const ALL: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

interface Props {
  days: Weekday[];
  onChange: (days: Weekday[]) => void;
}

export function WeekdayPicker({ days, onChange }: Props) {
  const { instrument, spacing, radius } = useTheme();

  const chip = (selected: boolean) => ({
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: selected ? instrument.accent : instrument.inset,
  });

  const toggleDay = (d: Weekday) =>
    onChange(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b));

  return (
    <>
      <View style={{ flexDirection: "row", gap: spacing.xs, marginTop: spacing.md }}>
        {DAY_CHIPS.map(({ day, label: l }) => {
          const on = days.includes(day);
          return (
            <Pressable key={day} testID={`day-${day}`} onPress={() => toggleDay(day)} style={[chip(on), { minWidth: 40, alignItems: "center" }]}>
              <AppText style={{ fontSize: 15, color: on ? instrument.accentOn : instrument.ink }}>{l}</AppText>
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={() => onChange(ALL)} style={{ marginTop: spacing.sm }}>
        <AppText style={{ fontSize: 13, color: instrument.mut }}>Select all days</AppText>
      </Pressable>
    </>
  );
}
