import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";
import { Icon } from "@/components/Icon";
import { Segmented } from "@/components/Segmented";
import { WeightChart } from "@/components/progress/WeightChart";
import { WeightLogSheet } from "@/components/progress/WeightLogSheet";
import { useDashboard, useProfile, useWeightSeries } from "@/api/hooks";
import type { WeightEntry } from "@/api/types";
import { AnimatedNumber, PressableScale } from "@/motion";
import { useTheme } from "@/theme";

const RANGES = ["1W", "1M", "3M", "1Y"] as const;
const RANGE_OPTIONS = RANGES.map((r) => ({ key: r, label: r }));

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
const shortDate = (isoStr: string) => new Date(isoStr).toLocaleDateString([], { month: "short", day: "numeric" });
const weightFormat = (n: number) => n.toFixed(1);

export default function Progress() {
  const { colors, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const [sheetOpen, setSheetOpen] = useState(false);
  const dashboard = useDashboard(today());
  const profile = useProfile();
  const series = useWeightSeries(range);
  const streak = dashboard.data?.streak_days ?? 0;

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (range switches / refetches update in place here,
  // no re-stagger on those).
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  const entries = (series.data ?? []) as WeightEntry[];
  const points = entries.map((e) => e.weight_kg);
  const hasChart = points.length >= 2;
  const current = entries.length ? entries[entries.length - 1].weight_kg : (profile.data?.weight_kg ?? 0);
  const delta = hasChart ? points[points.length - 1] - points[0] : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <Animated.View entering={enter(0)}>
        <ScreenHeader
          overline="Trends"
          title="Progress"
          right={
            <PressableScale
              accessibilityRole="button"
              haptic="selection"
              style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Icon name="camera" size={15} color={colors.label} />
              <AppText variant="footnote" style={{ fontWeight: "600" }}>Weekly report</AppText>
            </PressableScale>
          }
        />
      </Animated.View>

      <View style={{ paddingHorizontal: 16, gap: 16 }}>
        <Animated.View entering={enter(1)}>
          <Card style={{ padding: 18 }}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Log weight"
              haptic="selection"
              onPress={() => setSheetOpen(true)}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <View>
                  <AppText variant="footnote" muted style={{ fontWeight: "600" }}>Weight</AppText>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                    {current > 0 ? (
                      <AnimatedNumber
                        value={current}
                        format={weightFormat}
                        style={{ fontSize: 40, fontWeight: "700", fontFamily: fonts.rounded, color: colors.label }}
                      />
                    ) : (
                      <AppText style={{ fontSize: 40, fontWeight: "700", fontFamily: fonts.rounded, color: colors.label }}>—</AppText>
                    )}
                    <AppText variant="subheadline" muted>kg</AppText>
                  </View>
                </View>
                {delta !== null ? (
                  <Badge variant={delta <= 0 ? "success" : "neutral"} icon={delta <= 0 ? "trending-down" : "trending-up"}>{`${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`}</Badge>
                ) : null}
              </View>
            </PressableScale>

            {hasChart ? (
              <>
                <WeightChart points={points} />
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                  <AppText variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>{shortDate(entries[0].logged_at)}</AppText>
                  <AppText variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>{shortDate(entries[entries.length - 1].logged_at)}</AppText>
                </View>
              </>
            ) : (
              <AppText muted style={{ fontSize: 13, paddingVertical: 16, textAlign: "center" }}>Log your weight to see a trend.</AppText>
            )}

            <View style={{ marginTop: 14 }}>
              <Segmented options={RANGE_OPTIONS} value={range} onChange={(key) => setRange(key as (typeof RANGES)[number])} />
            </View>
          </Card>
        </Animated.View>

        <Animated.View entering={enter(2)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg intake" value="1,921" unit="kcal" delta="On target" trend="down" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Log streak" value={String(streak)} unit={streak === 1 ? "day" : "days"} delta="Keep it up" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg steps" value="8,240" delta="+6% wk" trend="up" /></Card>
          <Card style={{ flexGrow: 1, flexBasis: "45%" }}><Stat label="Avg sleep" value="7.1" unit="hrs" /></Card>
        </Animated.View>
      </View>

      <WeightLogSheet visible={sheetOpen} initialKg={current} onClose={() => setSheetOpen(false)} />
    </ScrollView>
  );
}
