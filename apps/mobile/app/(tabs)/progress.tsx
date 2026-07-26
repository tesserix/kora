import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Numeral } from "@/components/Numeral";
import { Badge } from "@/components/Badge";
import { Icon } from "@/components/Icon";
import { WeightChart } from "@/components/progress/WeightChart";
import { WeightLogSheet } from "@/components/progress/WeightLogSheet";
import { useDashboard, useProfile, useWeightSeries } from "@/api/hooks";
import type { WeightEntry } from "@/api/types";
import { useTheme } from "@/theme";

const RANGES = ["1W", "1M", "3M", "1Y"] as const;

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
const shortDate = (isoStr: string) => new Date(isoStr).toLocaleDateString([], { month: "short", day: "numeric" });

export default function Progress() {
  const { colors, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const [sheetOpen, setSheetOpen] = useState(false);
  const dashboard = useDashboard(today());
  const profile = useProfile();
  const series = useWeightSeries(range);
  const streak = dashboard.data?.streak_days ?? 0;

  const entries = (series.data ?? []) as WeightEntry[];
  const points = entries.map((e) => e.weight_kg);
  const hasChart = points.length >= 2;
  const current = entries.length ? entries[entries.length - 1].weight_kg : (profile.data?.weight_kg ?? 0);
  const delta = hasChart ? points[points.length - 1] - points[0] : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader
        overline="Trends"
        title="Progress"
        right={
          <Pressable accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Icon name="camera" size={15} color={colors.foreground} />
            <AppText style={{ fontSize: 13, fontWeight: "600" }}>Weekly report</AppText>
          </Pressable>
        }
      />

      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Card style={{ padding: 18 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Log weight" onPress={() => setSheetOpen(true)}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
              <View>
                <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>Weight</AppText>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                  <Numeral size={30}>{current > 0 ? current.toFixed(1) : "—"}</Numeral>
                  <AppText muted style={{ fontSize: 14 }}>kg</AppText>
                </View>
              </View>
              {delta !== null ? (
                <Badge variant={delta <= 0 ? "success" : "neutral"} icon={delta <= 0 ? "trending-down" : "trending-up"}>{`${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`}</Badge>
              ) : null}
            </View>
          </Pressable>

          {hasChart ? (
            <>
              <WeightChart points={points} />
              <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                <AppText muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{shortDate(entries[0].logged_at)}</AppText>
                <AppText muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{shortDate(entries[entries.length - 1].logged_at)}</AppText>
              </View>
            </>
          ) : (
            <AppText muted style={{ fontSize: 13, paddingVertical: 16, textAlign: "center" }}>Log your weight to see a trend.</AppText>
          )}

          <View style={{ flexDirection: "row", gap: 6, marginTop: 14 }}>
            {RANGES.map((r) => {
              const on = range === r;
              return (
                <Pressable key={r} accessibilityRole="button" onPress={() => setRange(r)} style={{ flex: 1, paddingVertical: 7, borderRadius: radius.md, alignItems: "center", backgroundColor: on ? colors.secondary : "transparent" }}>
                  <AppText style={{ fontFamily: fonts.mono, fontSize: 12, fontWeight: "700", color: on ? colors.primary : colors.mutedForeground }}>{r}</AppText>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg intake" value="1,921" unit="kcal" delta="On target" trend="down" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Log streak" value={String(streak)} unit={streak === 1 ? "day" : "days"} delta="Keep it up" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg steps" value="8,240" delta="+6% wk" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg sleep" value="7.1" unit="hrs" /></Card>
        </View>
      </View>

      <WeightLogSheet visible={sheetOpen} initialKg={current} onClose={() => setSheetOpen(false)} />
    </ScrollView>
  );
}
