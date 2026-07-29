import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Card } from "@/components/Card";
import { Overline } from "@/components/Overline";
import { MealRow } from "@/components/MealRow";
import { KcalHero } from "@/components/home/KcalHero";
import { SavedMealsStrip } from "@/components/home/SavedMealsStrip";
import { PinnedStrip } from "@/components/home/PinnedStrip";
import { YourUsualStrip } from "@/components/home/YourUsualStrip";
import { RingStat } from "@/components/RingStat";
import { EmptyState } from "@/components/common/EmptyState";
import { Icon } from "@/components/Icon";
import { AppBackground } from "@/components/AppBackground";
import { PressableScale } from "@/motion";
import { useProfile, useDashboard, useDayLogs, useUnreadCount } from "@/api/hooks";
import { useHealth } from "@/health";
import { useTheme } from "@/theme";
import { foodVisual } from "@/lib/foodVisual";
import { fibreGoal } from "@/lib/fibreGoal";
import { hslToHex, withAlpha } from "@/lib/color";
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
  const { colors, spacing, radius, gradients } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const unread = useUnreadCount();
  const health = useHealth();
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
  const hasUnread = (unread.data?.count ?? 0) > 0;

  const openMeal = (log: FoodLog) =>
    router.push({
      pathname: "/meal",
      params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) },
    });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 130 }}>
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Notifications"
            haptic="selection"
            onPress={() => router.push("/notifications")}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="bell" size={22} color={colors.label} />
            {hasUnread ? (
              <View
                testID="home-unread-badge"
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: colors.accent,
                }}
              />
            ) : null}
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Profile"
            haptic="selection"
            onPress={() => router.push("/profile")}
          >
            <Avatar initials={initials(profile.data?.display_name)} />
          </PressableScale>
        </View>
      </Animated.View>

      {/* error state keeps current copy + destructive color */}
      {loadError ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <AppText variant="subheadline" style={{ color: colors.destructive }}>
            Couldn't load your day. Pull to refresh or try again.
          </AppText>
        </View>
      ) : null}

      {/* hero — hidden entirely on load error so no contradictory "0 calories left" shows */}
      {!loadError ? (
        <Animated.View entering={enter(1)} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Card variant="hero">
            <KcalHero
              left={left}
              goal={goal}
              eaten={eaten}
              loading={!d}
              macros={
                d
                  ? {
                      p: d.consumed.protein_g,
                      c: d.consumed.carbs_g,
                      f: d.consumed.fat_g,
                      pGoal: d.targets.protein_g,
                      cGoal: d.targets.carbs_g,
                      fGoal: d.targets.fat_g,
                      fib: d.consumed.fiber_g,
                      fibGoal: fibreGoal(d.targets.kcal),
                    }
                  : undefined
              }
            />
          </Card>
        </Animated.View>
      ) : null}

      {/* today's vitals — Steps + Sleep, both driven live from Apple HealthKit via useHealth() */}
      {!loadError ? (
        <Animated.View entering={enter(2)} style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 }}>
          <Overline style={{ marginBottom: 8 }}>Today's vitals</Overline>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <Card variant="elevated" style={{ flexBasis: "48%", flexGrow: 1 }}>
              <RingStat
                label="Steps"
                dotColor={colors.stepsMetric}
                state={health.status === "authorized" ? "value" : "connect"}
                value={health.steps ? health.steps.today.toLocaleString() : undefined}
                meta={health.steps ? `of ${health.steps.goal.toLocaleString()}` : undefined}
                ringValue={health.steps?.today ?? 0}
                ringMax={health.steps?.goal ?? 0}
                ringGradient={gradients.steps}
                onConnect={health.connect}
              />
            </Card>
            <Card variant="elevated" style={{ flexBasis: "48%", flexGrow: 1 }}>
              <RingStat
                label="Sleep"
                dotColor={colors.sleepMetric}
                state={health.status === "authorized" ? "value" : "connect"}
                value={health.sleep ? `${health.sleep.lastNightHours}` : undefined}
                meta={health.sleep ? "last night" : undefined}
                ringValue={health.sleep?.lastNightHours ?? 0}
                ringMax={8}
                ringGradient={gradients.sleep}
                onConnect={health.connect}
              />
            </Card>
          </View>
        </Animated.View>
      ) : null}

      {/* meals */}
      <SavedMealsStrip />
      <PinnedStrip />
      <YourUsualStrip />
      {!loadError ? (
        <Animated.View entering={enter(3)} style={{ paddingHorizontal: 16, marginTop: 8 }}>
          <Overline style={{ marginBottom: 8 }}>Meals</Overline>
          {loggedMeals.length > 0 ? (
            <Card variant="elevated" style={{ marginBottom: 12, padding: 0, paddingVertical: spacing.sm }}>
              {loggedMeals.map((log, i) => {
                const fv = foodVisual(log.description);
                return (
                  <View key={log.id}>
                    <MealRow
                      name={log.description}
                      slot={`${log.meal_slot} · ${mealTime(log)}`}
                      kcal={log.kcal}
                      iconName={fv.icon}
                      tint={hslToHex(fv.hue, 0.5, 0.5)}
                      onPress={() => openMeal(log)}
                      accessibilityLabel={log.description}
                    />
                    {i < loggedMeals.length - 1 ? (
                      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.separator }} />
                    ) : null}
                  </View>
                );
              })}
            </Card>
          ) : (
            <EmptyState
              icon="camera"
              title="No meals logged yet"
              subtitle="Tap ✦ to log your first meal."
            />
          )}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Add a meal"
            haptic="selection"
            onPress={() => router.push("/capture")}
            style={{
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: withAlpha(colors.primary, 0.4),
              borderRadius: radius.lg,
              paddingVertical: 14,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppText style={{ color: colors.primary, fontWeight: "600" }}>Log a meal</AppText>
          </PressableScale>
        </Animated.View>
      ) : null}
      </ScrollView>
    </View>
  );
}
