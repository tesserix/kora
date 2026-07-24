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
import { useDashboard } from "@/api/hooks";
import { useTheme } from "@/theme";

// Placeholder sample series — weight tracking is a later phase.
const WEIGHTS = [74.2, 74.0, 73.6, 73.7, 73.1, 72.8, 72.4];
const LABELS = ["Jul 17", "", "Jul 19", "", "Jul 21", "", "Jul 23"];
const RANGES = ["1W", "1M", "3M", "1Y"] as const;

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

export default function Progress() {
  const { colors, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const dashboard = useDashboard(today());
  const streak = dashboard.data?.streak_days ?? 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader
        overline="Trends"
        title="Progress"
        right={
          <Pressable accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 }}>
            <Icon name="sparkles" size={15} color={colors.foreground} />
            <AppText style={{ fontSize: 13, fontWeight: "600" }}>Weekly report</AppText>
          </Pressable>
        }
      />

      <View style={{ paddingHorizontal: 20, gap: 16 }}>
        <Card style={{ padding: 18 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
            <View>
              <AppText muted style={{ fontSize: 12, fontWeight: "600" }}>Weight</AppText>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
                <Numeral size={30}>72.4</Numeral>
                <AppText muted style={{ fontSize: 14 }}>kg</AppText>
              </View>
            </View>
            <Badge variant="success" icon="trending-down">1.8 kg</Badge>
          </View>
          <WeightChart points={WEIGHTS} />
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
            {LABELS.map((l, i) => (
              <AppText key={i} muted style={{ fontFamily: fonts.mono, fontSize: 9 }}>{l}</AppText>
            ))}
          </View>
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
    </ScrollView>
  );
}
