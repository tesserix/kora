import { useEffect, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { SavedMealsStrip } from "@/components/home/SavedMealsStrip";
import { PinnedStrip } from "@/components/home/PinnedStrip";
import { YourUsualStrip } from "@/components/home/YourUsualStrip";
import { EmptyState } from "@/components/common/EmptyState";
import { AppBackground } from "@/components/AppBackground";
import { PressableScale } from "@/motion";
import { GaugeDial } from "@/components/instrument/GaugeDial";
import { GAUGE_VIEW_H } from "@/components/instrument/gauge";
import { MacroWide } from "@/components/instrument/MacroWide";
import { SubDial } from "@/components/instrument/SubDial";
import { TeleStrip, type TeleStripCell } from "@/components/instrument/TeleStrip";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { monoStyle } from "@/components/instrument/typography";
import { useProfile, useDashboard, useDayLogs, useUnreadCount } from "@/api/hooks";
import { useHealth } from "@/health";
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
// Meal-row slot label is sentence case, not engraved (see spec's ~4-engraved-label
// budget) — the raw meal_slot value is lowercase ("breakfast"), so capitalize it.
function sentenceCase(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export default function Home() {
  const { colors, spacing, radius, instrument, fonts } = useTheme();
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

  const mono = monoStyle(fonts);
  const engraved = {
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    color: instrument.mut,
  };
  // Sentence-case demotion for labels that would otherwise push the screen past
  // the spec's ~4-visible-engraved-label budget (Energy reserve caption + the
  // GaugeDial footer group + MacroWide's own label + TeleStrip's own labels
  // already account for that budget — see task-8 fix report).
  const mutedLabel = { fontSize: 11, color: instrument.mut };

  const d = dashboard.data;
  const loadError = dashboard.isError || logs.isError;
  // No dashboard data yet and no error means the query hasn't resolved — distinct
  // from a resolved dashboard with genuinely zero consumption (first-run day),
  // which must still show real "0" values, not a placeholder.
  const pending = !d && !loadError;
  const eaten = d?.consumed.kcal ?? 0;
  const goal = d?.targets.kcal ?? 0;
  const loggedMeals = (logs.data ?? []) as FoodLog[];
  const firstName = profile.data?.display_name?.trim().split(" ")[0] || "there";
  const hasUnread = (unread.data?.count ?? 0) > 0;

  const proteinValue = Math.round(d?.consumed.protein_g ?? 0);
  const proteinGoal = Math.round(d?.targets.protein_g ?? 0);
  const carbsValue = Math.round(d?.consumed.carbs_g ?? 0);
  const carbsGoal = Math.round(d?.targets.carbs_g ?? 0);
  const fatValue = Math.round(d?.consumed.fat_g ?? 0);
  const fatGoal = Math.round(d?.targets.fat_g ?? 0);

  // Dashboard `Totals` (src/api/types.ts) has no burned/active-energy field —
  // GaugeDial's `burned` prop is intentionally omitted rather than guessed.
  const stepsCell: TeleStripCell = health.steps
    ? { icon: <Icon name="footprints" size={16} color={instrument.mut} />, value: health.steps.today.toLocaleString(), label: "Steps" }
    : {
        icon: (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Connect Apple Health"
            haptic="selection"
            onPress={health.connect}
          >
            <Icon name="footprints" size={16} color={instrument.mut} />
          </PressableScale>
        ),
        value: "—",
        label: "Steps",
      };
  const sleepCell: TeleStripCell = health.sleep
    ? { icon: <Icon name="moon" size={16} color={instrument.mut} />, value: `${health.sleep.lastNightHours}h`, label: "Sleep" }
    : {
        icon: (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Connect Apple Health"
            haptic="selection"
            onPress={health.connect}
          >
            <Icon name="moon" size={16} color={instrument.mut} />
          </PressableScale>
        ),
        value: "—",
        label: "Sleep",
      };

  const openMeal = (log: FoodLog) =>
    router.push({
      pathname: "/meal",
      params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) },
    });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 130 }}>
      {/* header: date sentence-case · greeting, avatar, bell */}
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
                  backgroundColor: instrument.accent,
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

      {/* energy reserve dial — hidden entirely on load error so no contradictory reserve figure shows.
          While pending, a same-height "—" placeholder stands in so a fresh fetch never flashes
          a fabricated "0 in reserve" / "0 of 0" before real targets are known. */}
      {!loadError ? (
        <Animated.View entering={enter(1)} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <GlassPanel radius={24} style={{ padding: 16 }}>
            <AppText style={[engraved, { marginBottom: 8 }]}>Energy reserve</AppText>
            {pending ? (
              <View
                testID="gauge-dial-placeholder"
                style={{ height: GAUGE_VIEW_H + 60, alignItems: "center", justifyContent: "center" }}
              >
                <AppText style={[{ fontSize: 54, color: instrument.mut, letterSpacing: -1.5 }, mono]}>—</AppText>
              </View>
            ) : (
              <GaugeDial value={eaten} target={goal} />
            )}
          </GlassPanel>
        </Animated.View>
      ) : null}

      {/* macros — protein full-width, carbs/fat compact pair (deliberate asymmetry).
          Same pending guard as the gauge: no fabricated 0/0 before the dashboard resolves. */}
      {!loadError ? (
        <Animated.View entering={enter(2)} style={{ paddingHorizontal: 16, gap: 12 }}>
          {pending ? (
            <GlassPanel radius={22} testID="macro-wide-placeholder">
              <View style={{ padding: 14 }}>
                <AppText style={[mutedLabel, mono]}>—</AppText>
              </View>
            </GlassPanel>
          ) : (
            <MacroWide label="Protein" value={proteinValue} goal={proteinGoal} unit="g" />
          )}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <GlassPanel radius={20} style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10 }}>
                <SubDial fraction={pending || carbsGoal === 0 ? 0 : carbsValue / carbsGoal} testID="carbs-subdial" />
                <View>
                  <AppText style={mutedLabel}>Carbs</AppText>
                  <AppText style={[{ fontSize: 13, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}>
                    {pending ? "—" : `${carbsValue}/${carbsGoal}g`}
                  </AppText>
                </View>
              </View>
            </GlassPanel>
            <GlassPanel radius={20} style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 10 }}>
                <SubDial fraction={pending || fatGoal === 0 ? 0 : fatValue / fatGoal} testID="fat-subdial" />
                <View>
                  <AppText style={mutedLabel}>Fat</AppText>
                  <AppText style={[{ fontSize: 13, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}>
                    {pending ? "—" : `${fatValue}/${fatGoal}g`}
                  </AppText>
                </View>
              </View>
            </GlassPanel>
          </View>
        </Animated.View>
      ) : null}

      {/* today's vitals — Steps + Sleep, both driven live from Apple HealthKit via useHealth() */}
      {!loadError ? (
        <Animated.View entering={enter(3)} style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          {/* Gated on `health.steps`/`health.sleep`, not `health.status`: HealthKit never
              discloses whether READ access was actually granted, so "authorized" status
              alone cannot tell a real 0 from a denial. A user who has genuinely logged no
              steps/sleep yet today will see the connect prompt too — accepted, since the
              alternative (a denied user stuck on a false "0" with no way back) is worse. */}
          <TeleStrip cells={[stepsCell, sleepCell]} />
        </Animated.View>
      ) : null}

      {/* meals */}
      <SavedMealsStrip />
      <PinnedStrip />
      <YourUsualStrip />
      {!loadError ? (
        <Animated.View entering={enter(4)} style={{ paddingHorizontal: 16, marginTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <AppText style={{ fontSize: 14, fontWeight: "600", color: instrument.ink }}>Logged today</AppText>
            <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
          </View>
          {loggedMeals.length > 0 ? (
            <View style={{ marginBottom: 12 }}>
              {loggedMeals.map((log, i) => (
                <View key={log.id}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={log.description}
                    haptic="selection"
                    onPress={() => openMeal(log)}
                    style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}
                  >
                    <AppText style={[{ fontSize: 12, color: instrument.mut, width: 60 }, mono]}>
                      {mealTime(log)}
                    </AppText>
                    <View style={{ flex: 1 }}>
                      <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
                        {log.description}
                      </AppText>
                      <AppText style={[mutedLabel, { marginTop: 2 }]}>{sentenceCase(log.meal_slot)}</AppText>
                    </View>
                    <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>
                      {Math.round(log.kcal)} kcal
                    </AppText>
                  </PressableScale>
                  {i < loggedMeals.length - 1 ? (
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                  ) : null}
                </View>
              ))}
            </View>
          ) : (
            <EmptyState
              icon="camera"
              title="No meals logged yet"
              subtitle="Tap ✦ to log your first meal."
            />
          )}
          {/* Dashed ghost-slot CTA — same recipe as Diary's "Add {slot} · N
              kcal in reserve" row (instrument.tick dashed border, accent
              icon, mut label; the icon is the one accent element here). */}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Add a meal"
            haptic="selection"
            onPress={() => router.push("/capture")}
            style={{
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: instrument.tick,
              borderRadius: radius.lg,
              paddingVertical: 14,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}
          >
            <Icon name="plus" size={16} color={instrument.accent} />
            <AppText style={{ color: instrument.mut, fontWeight: "600" }}>Log a meal</AppText>
          </PressableScale>
        </Animated.View>
      ) : null}
      </ScrollView>
    </View>
  );
}
