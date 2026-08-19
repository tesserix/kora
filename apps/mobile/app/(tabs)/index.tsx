import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { SavedMealsStrip } from "@/components/home/SavedMealsStrip";
import { PinnedStrip } from "@/components/home/PinnedStrip";
import { YourUsualStrip } from "@/components/home/YourUsualStrip";
import { MacroCell } from "@/components/home/MacroCell";
import { CoachEntryCard } from "@/components/home/CoachEntryCard";
import { EmptyState } from "@/components/common/EmptyState";
import { AppBackground } from "@/components/AppBackground";
import { PressableScale, ScreenEntrance, useMotionPrefs } from "@/motion";
import { useDailyIgnition } from "@/motion/useDailyIgnition";
import { GaugeDial, type GaugeDialHandle } from "@/components/instrument/GaugeDial";
import { GAUGE_VIEW_H } from "@/components/instrument/gauge";
import { SpecularSweep } from "@/components/instrument/SpecularSweep";
import { BezelCluster, ZoneRule, WellFooter } from "@/components/instrument/BezelCluster";
import { monoStyle } from "@/components/instrument/typography";
import { useProfile, useDashboard, useDayLogs, useUnreadCount, useCoachNudges } from "@/api/hooks";
import { useHealth } from "@/health";
import { useTheme } from "@/theme";
import { accessibleMealLabel } from "@/lib/portionAssumedLabel";
import { now, todayLocalDate } from "@/lib/shotsClock";
import type { FoodLog } from "@/api/types";
import type { ReactNode } from "react";

// Shape of the steps/sleep telemetry cells rendered below (kora ignition
// review, Finding 4: was imported from the now-deleted TeleStrip.tsx, which
// rendered nowhere — this is the only surviving consumer of the shape).
interface TelemetryCell {
  icon: ReactNode;
  value: string;
  label: string;
}

// These three read the clock through `now()` rather than `new Date()` so the
// screenshot harness can pin them (src/lib/shotsClock.ts). Outside a dev build
// with EXPO_PUBLIC_SHOTS_CLOCK set, `now()` IS `new Date()`.
function today(): string {
  return todayLocalDate();
}
function greeting(): string {
  const h = now().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function dateLabel(): string {
  return now().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
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
  const coachNudges = useCoachNudges();
  const health = useHealth();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);

  // Entrance stagger runs on first mount only — refetches (e.g. pull-to-refresh,
  // React Query background revalidation) update `dashboard`/`logs` in place
  // without unmounting this screen, so `firstMount.current` is already false
  // by the time those re-renders happen and no re-stagger occurs.
  const { reduceMotion } = useMotionPrefs();
  // Once-a-day flourish (Task 4): mounts false and flips true at most once per
  // local-day key, persisted across restarts — suppressed entirely under
  // Reduce Motion rather than degraded, same as every other flourish here.
  const ignite = useDailyIgnition(date, reduceMotion);
  const gaugeRef = useRef<GaugeDialHandle>(null);
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  // Reduce Motion keeps the fade and drops the translate. Reanimated 4.5
  // would otherwise degrade FadeInDown to an instant pop-in, throwing away
  // the opacity half that is exactly the prescribed fallback.
  const enter = (i: number) =>
    firstMount.current
      ? reduceMotion
        ? FadeIn.duration(150).delay(i * 30)
        : FadeInDown.duration(300).delay(i * 30)
      : undefined;

  // Pull to refresh. The error copy below has promised this since the screen was
  // written, and useHealth otherwise only re-reads on foreground/focus — this is
  // the deliberate path for "I just walked, show me now" without leaving the app.
  // Failures are swallowed on purpose: each source already surfaces its own error
  // state (dashboard.isError, or steps falling back to "—"), and a rejected
  // refetch must still end the spinner rather than leave it turning forever.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Refresh-begin needle sweep (Step 5) — a visual "reading now" cue that
    // runs alongside the refetch, not gated on its result. sweep() itself
    // no-ops under Reduce Motion, and the ref is null while the placeholder
    // (pending) is mounted, so this is safe in every state.
    gaugeRef.current?.sweep();
    try {
      await Promise.all([
        dashboard.refetch().catch(() => {}),
        logs.refetch().catch(() => {}),
        health.refresh().catch(() => {}),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [dashboard, logs, health]);

  const mono = monoStyle(fonts);
  const engraved = {
    fontSize: 9,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    color: instrument.mut,
  };
  // Sentence-case demotion for labels that would otherwise push the screen past
  // the spec's ~4-visible-engraved-label budget (Energy reserve caption + the
  // GaugeDial footer group + the telemetry cells' own labels already account
  // for that budget — see task-8 fix report).
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

  const MACROS = [
    { key: "protein", label: "Protein", have: proteinValue, target: proteinGoal },
    { key: "carbs", label: "Carbs", have: carbsValue, target: carbsGoal },
    { key: "fat", label: "Fat", have: fatValue, target: fatGoal },
  ] as const;

  // Dashboard `Totals` (src/api/types.ts) has no burned/active-energy field —
  // GaugeDial's `burned` prop is intentionally omitted rather than guessed.
  const stepsCell: TelemetryCell = health.steps
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
  const sleepCell: TelemetryCell = health.sleep
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
    <ScreenEntrance direction={0}>
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView
        testID="home-scroll"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 130 }}
        refreshControl={
          <RefreshControl
            testID="home-refresh"
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={instrument.mut}
          />
        }
      >
      {/* header: date sentence-case · greeting, avatar, bell */}
      <Animated.View
        entering={enter(0)}
        style={{ paddingHorizontal: 16, paddingBottom: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" }}
      >
        {/* `flexShrink: 1`, with NO grow and NO basis — this one line is the
            whole fix for kora#276, and it is the INVERSE of the kora#266 bug
            in ScreenHeader rather than a repeat of it.

            React Native defaults `flexShrink` to 0 (the web defaults to 1), so
            before this both children of the row were unshrinkable. Each claimed
            its hypothetical width, the row overflowed, and the overflow went
            off the RIGHT edge because `space-between` cannot reclaim space it
            does not have. Measured on iPhone 17 Pro Max (440pt wide, 408pt
            inner) at accessibility-extra-large:

              before  title column 408pt | bell x=424..464 | avatar x=476..516
              after   title column 316pt | bell x=332..372 | avatar x=384..424

            The bell's tap centre sat at x=444 — four points PAST the screen —
            and the avatar was off-screen entirely. Only a 16pt sliver of the
            bell was painted, which is why this reads as a rendering artefact in
            a screenshot rather than as two unreachable controls.

            Shrinking the ACTIONS instead is the wrong lever and was tried and
            rejected in kora#263: a shrink box narrows past the word it holds,
            which there split "kg" into "k" / "g". Two 40x40 icon buttons have
            no reflow to give — they would just be drawn smaller than their own
            glyphs. So the type yields and the controls hold.

            NOT `flex: 1`, which is the mistake kora#266 had to undo: that adds
            `flexGrow: 1` + `flexBasis: 0`, so the column would be sized from
            whatever the actions left over with no floor, and it would grow to
            fill at `medium` too. With plain `flexShrink: 1` the column measures
            its own type and yields only the 92pt it actually has to. At
            `medium` the two columns hypothetically measure 228 + 92 of 408 —
            no overflow, so nothing shrinks and nothing moves. Verified by
            byte-identical screenshot, not by the suite; 1,729 green tests hid
            the original rendering bug (kora#257). */}
        <View style={{ flexShrink: 1 }}>
          <AppText variant="subheadline" muted>
            {dateLabel()} · {greeting()}, {firstName}
          </AppText>
          <AppText variant="largeTitle">Today</AppText>
        </View>
        {/* `flexShrink: 0` is already RN's default and is stated anyway: it is
            the half of the fix that is load-bearing but invisible, and a later
            edit adding `flex: 1` here would silently reopen kora#276. */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexShrink: 0 }}>
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

      {/* the fused hero — one bezel-grade instrument per screen (spec 2026-08-16
          "Home recomposition"), replacing the old gauge/macro-pair/vitals stack.
          Hidden entirely on load error so no contradictory reserve figure shows. */}
      {!loadError ? (
        <Animated.View entering={enter(1)} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <BezelCluster glow testID="home-hero">
            {ignite ? <SpecularSweep /> : null}
            <View style={{ padding: 16 }}>
              <AppText maxFontSizeMultiplier={1.4} style={[engraved, { marginBottom: 8 }]}>Energy reserve</AppText>
              {pending ? (
                // Same-height "—" placeholder so a fresh fetch never flashes a
                // fabricated "0 in reserve" / "0 of 0" before real targets are known.
                <View
                  testID="gauge-dial-placeholder"
                  style={{ height: GAUGE_VIEW_H + 60, alignItems: "center", justifyContent: "center" }}
                >
                  <AppText style={[{ fontSize: 54, color: instrument.mut, letterSpacing: -1.5 }, mono]}>—</AppText>
                </View>
              ) : (
                <GaugeDial ref={gaugeRef} value={eaten} target={goal} ignition={ignite} />
              )}
            </View>
            <ZoneRule label="Macros" />
            <View style={{ flexDirection: "row" }}>
              {MACROS.map((m, i) => (
                <MacroCell key={m.key} first={i === 0} label={m.label} have={m.have} target={m.target} pending={pending} />
              ))}
            </View>
            {/* today's vitals — Steps + Sleep, both driven live from Apple HealthKit via
                useHealth(). Gated on `health.steps`/`health.sleep`, not `health.status`:
                HealthKit never discloses whether READ access was actually granted, so
                "authorized" status alone cannot tell a real 0 from a denial. A user who
                has genuinely logged no steps/sleep yet today will see the connect prompt
                too — accepted, since the alternative (a denied user stuck on a false "0"
                with no way back) is worse. */}
            <WellFooter testID="home-vitals">
              {[stepsCell, sleepCell].map((c, i) => (
                <Fragment key={c.label}>
                  {i > 0 ? (
                    <View style={{ width: 1, height: 30, backgroundColor: instrument.hairline, marginHorizontal: 16 }} />
                  ) : null}
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 12 }}>
                    {/* 34px glyph tile: glass fill + glassBorder ring, per the
                        design contract's recessed-footer recipe — `shade` is
                        bezel-bottom gradient shading, not a surface fill. */}
                    <View
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 10,
                        backgroundColor: instrument.glass,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: instrument.glassBorder,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {c.icon}
                    </View>
                    <View>
                      <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>{c.value}</AppText>
                      <AppText maxFontSizeMultiplier={1.4} style={mutedLabel}>{c.label}</AppText>
                    </View>
                  </View>
                </Fragment>
              ))}
            </WellFooter>
          </BezelCluster>
        </Animated.View>
      ) : null}

      <View style={{ paddingHorizontal: 16, marginTop: 4 }}>
        <CoachEntryCard
          nudge={coachNudges.data?.nudges[0]}
          onPress={() => router.push("/coach")}
        />
      </View>

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
                    accessibilityLabel={accessibleMealLabel(log.description, log.portion_assumed === true)}
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
                      <AppText maxFontSizeMultiplier={1.4} style={[mutedLabel, { marginTop: 2 }]}>{sentenceCase(log.meal_slot)}</AppText>
                      {log.portion_assumed ? (
                        // Same engraved marker MealRow renders in the diary
                        // (#138) — hand-rolled here because this row is
                        // bespoke markup, not a MealRow instance, but the
                        // words and treatment must still read as one signal.
                        <AppText
                          style={{
                            color: instrument.mut,
                            fontSize: 9,
                            fontWeight: "700",
                            textTransform: "uppercase",
                            letterSpacing: 1,
                            marginTop: 2,
                          }}
                        >
                          portion is a guess
                        </AppText>
                      ) : null}
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
              variant="instrument"
              icon="camera"
              title="No meals logged yet"
              subtitle="The gauge is full and waiting. Point the camera at your first meal."
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
    </ScreenEntrance>
  );
}
