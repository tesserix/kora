import { View } from "react-native";
import { CircularProgress } from "@/components/CircularProgress";
import { AppText } from "@/components/Text";
import { Numeral } from "@/components/Numeral";
import { dot, MACRO } from "@/lib/hue";
import { useTheme } from "@/theme";

type Macros = { p: number; c: number; f: number; pGoal: number; cGoal: number; fGoal: number };

export function FuelStrip({ eaten, goal, macros }: { eaten: number; goal: number; macros: Macros }) {
  const { colors, radius, fonts, shadows } = useTheme();
  const pct = goal > 0 ? Math.round(Math.min(100, (eaten / goal) * 100)) : 0;
  const rows: ReadonlyArray<readonly [string, number, number, number]> = [
    ["P", macros.p, macros.pGoal, MACRO.protein.hue],
    ["C", macros.c, macros.cGoal, MACRO.carbs.hue],
    ["F", macros.f, macros.fGoal, MACRO.fat.hue],
  ];
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 16, padding: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.xl }, shadows.sm]}>
      <CircularProgress value={eaten} max={goal} size={54} stroke={6}>
        <Numeral size={11} weight="800">{pct}%</Numeral>
      </CircularProgress>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 5 }}>
          <Numeral size={17}>{Math.round(Math.max(0, goal - eaten)).toLocaleString()}</Numeral>
          <AppText muted style={{ fontSize: 12 }}>kcal left · {Math.round(eaten).toLocaleString()} of {Math.round(goal).toLocaleString()}</AppText>
        </View>
        <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
          {rows.map(([label, v, g, hue]) => (
            <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: dot(hue) }} />
              <AppText muted style={{ fontFamily: fonts.mono, fontSize: 11 }}>{label} {Math.round(v)}/{Math.round(g)}g</AppText>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}
