import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { Numeral } from "@/components/Numeral";
import { Overline } from "@/components/Overline";
import { FoodTile } from "@/components/FoodTile";
import { useDashboard, useDayLogs } from "@/api/hooks";
import { foodVisual } from "@/lib/foodVisual";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

function weekDates(): Date[] {
  const now = new Date();
  const monday = new Date(now);
  const day = (now.getDay() + 6) % 7; // 0 = Monday
  monday.setDate(now.getDate() - day);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}
const iso = (d: Date) => d.toLocaleDateString("en-CA");
const timeOf = (s: string) => new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export default function Diary() {
  const { colors, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const week = weekDates();
  const todayIso = iso(new Date());
  const [selected, setSelected] = useState(todayIso);
  const dashboard = useDashboard(selected);
  const logs = useDayLogs(selected);

  const d = dashboard.data;
  const total = Math.round(d?.consumed.kcal ?? 0);
  const remaining = Math.max(0, Math.round((d?.targets.kcal ?? 0) - (d?.consumed.kcal ?? 0)));
  const water = ((d?.water_ml ?? 0) / 1000).toFixed(1);
  const logged = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({ pathname: "/meal", params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: timeOf(log.logged_at), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) } });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="This week" title="Diary" />

      {/* week strip */}
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingBottom: 8 }}>
        {week.map((date, i) => {
          const dISO = iso(date);
          const on = dISO === selected;
          const loggable = dISO <= todayIso;
          return (
            <Pressable
              key={dISO}
              accessibilityRole="button"
              onPress={() => setSelected(dISO)}
              style={{ flex: 1, borderRadius: radius.lg, borderWidth: on ? 0 : 1, borderColor: colors.border, backgroundColor: on ? colors.primary : colors.card, paddingVertical: 10, alignItems: "center", gap: 4 }}
            >
              <AppText style={{ fontSize: 11, fontWeight: "600", color: on ? colors.primaryForeground : colors.mutedForeground }}>{DOW[date.getDay()]}</AppText>
              <AppText style={{ fontSize: 16, fontWeight: "700", color: on ? colors.primaryForeground : colors.foreground }}>{date.getDate()}</AppText>
              <View style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: loggable ? (on ? colors.primaryForeground : colors.primary) : "transparent" }} />
            </Pressable>
          );
        })}
      </View>

      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <Stat label="Total intake" value={total.toLocaleString()} unit="kcal" />
          <View style={{ height: 40, width: 1, backgroundColor: colors.border }} />
          <Stat label="Remaining" value={remaining.toLocaleString()} unit="kcal" />
          <View style={{ height: 40, width: 1, backgroundColor: colors.border }} />
          <Stat label="Water" value={water} unit="L" />
        </Card>

        <Overline style={{ fontSize: 13, letterSpacing: 1 }}>Timeline</Overline>
        <View style={{ marginTop: 10, paddingLeft: 20 }}>
          <View style={{ position: "absolute", left: 5, top: 6, bottom: 6, width: 2, backgroundColor: colors.border }} />
          {logged.length === 0 ? <AppText muted style={{ paddingVertical: 12 }}>Nothing logged this day.</AppText> : null}
          {logged.map((log) => {
            const vis = foodVisual(log.description, log.meal_slot);
            return (
              <Pressable key={log.id} accessibilityRole="button" onPress={() => openMeal(log)} style={{ flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 10 }}>
                <View style={{ position: "absolute", left: -18, top: 22, width: 10, height: 10, borderRadius: 999, backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.background }} />
                <FoodTile hue={vis.hue} icon={vis.icon} size={48} />
                <View style={{ flex: 1 }}>
                  <AppText muted style={{ fontSize: 12, fontFamily: fonts.mono }}>{timeOf(log.logged_at)}</AppText>
                  <AppText style={{ fontSize: 15, fontWeight: "600" }}>{log.description}</AppText>
                  <AppText muted style={{ fontSize: 12 }}>{log.meal_slot} · {Math.round(log.quantity_grams)}g</AppText>
                </View>
                <Numeral size={14} weight="700">{Math.round(log.kcal)}</Numeral>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}
