import { StyleSheet, View } from "react-native";
import { AppText } from "@/components/Text";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { monoStyle } from "@/components/instrument/typography";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export interface WeekRailDay {
  date: Date;
  dow: string;
  iso: string;
  selected: boolean;
  today: boolean;
  hitGoal: boolean;
}

interface WeekDayCellProps {
  day: WeekRailDay;
  onSelect: (iso: string) => void;
}

// A single week-strip day (spec 2026-08-16 "Diary recomposition"): weekday
// caption + mono day number + a 4pt goal-hit pip. The selected day sinks into
// the bezel's well — instrument.inset fill, a wellShadow top inner line (the
// same recessed-edge trick WellFooter uses), and a glassBorder ring. No other
// affordance distinguishes it, so this is load-bearing, not decorative.
function WeekDayCell({ day, onSelect }: WeekDayCellProps) {
  const { instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  const { date, dow, iso, selected, today, hitGoal } = day;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={iso}
      accessibilityState={{ selected }}
      haptic="selection"
      onPress={() => onSelect(iso)}
      testID={`week-cell-${iso}`}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        paddingVertical: 8,
        minHeight: 44,
        borderRadius: 14,
        overflow: "hidden",
        backgroundColor: selected ? instrument.inset : "transparent",
        borderWidth: selected ? StyleSheet.hairlineWidth : 0,
        borderColor: instrument.glassBorder,
      }}
    >
      {selected ? (
        <View
          testID={`week-cell-${iso}-well-line`}
          pointerEvents="none"
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: instrument.wellShadow }}
        />
      ) : null}
      <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 11, color: instrument.mut }}>{dow}</AppText>
      <AppText
        maxFontSizeMultiplier={1.6}
        style={[{ fontSize: 15, fontWeight: "600", color: today || selected ? instrument.ink : instrument.mut }, mono]}
      >
        {date.getDate()}
      </AppText>
      {/* Goal pips never carry the accent (spec: accent budget — Diary's ONE
          accent is the day-total track). A met goal lights the pip in
          tickLit, unmet stays at the dim tick — no glow either way. */}
      <View
        testID={`week-pip-${iso}`}
        style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: hitGoal ? instrument.tickLit : instrument.tick }}
      />
    </PressableScale>
  );
}

export interface WeekRailProps {
  days: WeekRailDay[];
  onSelectDay: (iso: string) => void;
}

// The 7-cell week strip, bezeled (spec Step 2): radius 21, no glow — this is a
// small utility cluster, not the screen's hero instrument.
export function WeekRail({ days, onSelectDay }: WeekRailProps) {
  return (
    <BezelCluster radius={21}>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        {days.map((day) => (
          <WeekDayCell key={day.iso} day={day} onSelect={onSelectDay} />
        ))}
      </View>
    </BezelCluster>
  );
}
