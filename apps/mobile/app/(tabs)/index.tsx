import { useEffect, useRef } from "react";
import { ScrollView, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Card } from "@/components/Card";
import { GroupedSection, Row } from "@/components/GroupedList";
import { KcalHero } from "@/components/home/KcalHero";
import { MacroBars } from "@/components/home/MacroBars";
import { useProfile, useDashboard, useDayLogs } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function dateLabel(): string {
  return new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function initials(name?: string): string {
  if (!name) return "K";
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}
function mealTime(log: FoodLog): string {
  return new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);

  // Entrance stagger runs on first mount only — refetches (e.g. pull-to-refresh,
  // React Query background revalidation) update `dashboard`/`logs` in place
  // without unmounting this screen, so `firstMount.current` is already false
  // by the time those re-renders happen and no re-stagger occurs.
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  const d = dashboard.data;
  const loadError = dashboard.isError || logs.isError;
  const eaten = d?.consumed.kcal ?? 0;
  const goal = d?.targets.kcal ?? 0;
  const left = Math.round(Math.max(0, goal - eaten));
  const loggedMeals = (logs.data ?? []) as FoodLog[];
  const firstName = profile.data?.display_name?.trim().split(" ")[0] || "there";

  const openMeal = (log: FoodLog) =>
    router.push({
      pathname: "/meal",
      params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) },
    });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 130 }}>
      {/* header: large title */}
      <Animated.View
        entering={enter(0)}
        style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}
      >
        <View>
          <AppText variant="subheadline" muted>
            {dateLabel()} · {greeting()}, {firstName}
          </AppText>
          <AppText variant="largeTitle">Today</AppText>
        </View>
        <Avatar initials={initials(profile.data?.display_name)} />
      </Animated.View>

      {/* error state keeps current copy + destructive color */}
      {loadError ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <AppText variant="subheadline" style={{ color: colors.destructive }}>
            Couldn't load your day. Pull to refresh or try again.
          </AppText>
        </View>
      ) : null}

      {/* hero */}
      <Animated.View entering={enter(1)} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
        <Card>
          <KcalHero left={left} goal={goal} eaten={eaten} loading={!d && !loadError} />
          {d ? (
            <MacroBars
              macros={{
                p: d.consumed.protein_g,
                c: d.consumed.carbs_g,
                f: d.consumed.fat_g,
                pGoal: d.targets.protein_g,
                cGoal: d.targets.carbs_g,
                fGoal: d.targets.fat_g,
              }}
            />
          ) : null}
        </Card>
      </Animated.View>

      {/* meals */}
      <Animated.View entering={enter(2)}>
        <GroupedSection header="Meals" style={{ paddingHorizontal: 16, marginTop: 8 }}>
          {loggedMeals.map((log) => (
            <Row
              key={log.id}
              title={log.description}
              subtitle={`${log.meal_slot} · ${mealTime(log)}`}
              detail={`${Math.round(log.kcal)} kcal`}
              chevron
              onPress={() => openMeal(log)}
            />
          ))}
          <Row
            title="Log a meal"
            icon={{ name: "plus", tint: colors.primary }}
            accessibilityLabel="Add a meal"
            onPress={() => router.push("/capture")}
          />
        </GroupedSection>
      </Animated.View>
    </ScrollView>
  );
}
