import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "@/components/Text";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Icon } from "@/components/Icon";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { EnergyBars, type EnergyBarsDay } from "@/components/instrument/EnergyBars";
import { StreakCells } from "@/components/instrument/StreakCells";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { engravedStyle, monoStyle } from "@/components/instrument/typography";
import { WeightChart } from "@/components/progress/WeightChart";
import { LogWeightSheet } from "@/components/progress/LogWeightSheet";
import { MetricChips } from "@/components/progress/MetricChips";
import { deltaColor } from "@/components/progress/deltaColor";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { useAvgIntake7d, useDashboard, useProfile, useWeightSeries } from "@/api/hooks";
import type { WeightEntry } from "@/api/types";
import { useHealth } from "@/health";
import { AnimatedNumber, PressableScale, ScreenEntrance, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";
import { todayLocalDate } from "@/lib/shotsClock";
import {
  compositionMetric,
  displayNumber,
  formatMetricNumber,
  sourceLabel,
  unitLabel,
  type CompositionMetricKey,
} from "@/lib/bodyCompositionFields";
import {
  chartableMetrics,
  hasInstrumentChange,
  lastComparableRun,
  metricSeries,
} from "@/lib/bodyCompositionSeries";
import { useUnits } from "@/units";
import { TAB_BAR_SCROLL_INSET } from "@/components/FloatingTabBar";

const RANGES = ["1W", "1M", "3M", "1Y"] as const;
const RANGE_OPTIONS = RANGES.map((r) => ({ key: r, label: r }));

// EnergyBars' own default `targetFraction` is 0.74 — bars are scaled to that
// same headroom (target sits at 74% of the bar's max) so a day exactly at
// budget lands its bar top right on the dashed target line, and an over-budget
// day visibly pokes past it. Keeping this in lockstep with the component's
// default (rather than overriding targetFraction here) is what makes the two
// numbers agree.
const ENERGY_TARGET_FRACTION = 0.74;
const SLEEP_TARGET_HOURS = 7;

// Pinnable for the screenshot harness; identical to `new Date()` everywhere
// else. See src/lib/shotsClock.ts.
function today(): string {
  return todayLocalDate();
}
const shortDate = (isoStr: string) => new Date(isoStr).toLocaleDateString([], { month: "short", day: "numeric" });

// Data-honesty fix (task-11 review, finding 2): useAvgIntake7d's `series`
// (src/api/hooks.ts) is `number[]` — it carries NO dates, and only includes
// the days in the trailing week that actually have logged data (an unlogged
// day is dropped entirely, not represented as a zero; see its own
// never-fabricate filter/comment). Left-padding those values onto real
// weekday letters, as the first pass here did, silently misattributed a kcal
// total to the wrong day whenever the gap was mid-week rather than at the
// start of the window — e.g. a week logged Mon/Wed/Fri would have rendered as
// if Mon/Tue/Wed were logged and Thu–Sun were empty. Since the series has no
// dates to map by, the only honest label is "no day attribution": every bar
// but the most recent (rightmost, chronologically last) is unlabeled, and
// only that last one is marked "today" — the one position the series' own
// chronological ordering actually guarantees.
function buildEnergyDays(series: number[], targetKcal: number): EnergyBarsDay[] {
  const padded = Array(Math.max(0, 7 - series.length)).fill(0).concat(series).slice(-7);
  const maxRef = targetKcal > 0 ? targetKcal / ENERGY_TARGET_FRACTION : 0;
  return padded.map((kcal, i) => {
    const fraction = maxRef > 0 ? Math.min(kcal / maxRef, 1) : 0;
    return { label: i === padded.length - 1 ? "today" : "—", fraction, over: targetKcal > 0 && kcal > targetKcal };
  });
}

// Trailing-fill transform: turns a scalar streak count into a row of cells
// feeding StreakCells (the instrument-glass replacement for the deleted
// legacy StreakBars component).
function trailingStreakHits(count: number, window = 7): boolean[] {
  const filled = Math.min(Math.max(0, count), window);
  return Array.from({ length: window }, (_, i) => i >= window - filled);
}

// HealthKit (useHealth) only ever reports *today's* sleep — there is no
// history — so every cell but today intentionally stays unlit ("no data")
// rather than fabricating a multi-day streak.
function sleepStreakHits(lastNightHours: number | null): boolean[] {
  const hits = Array(7).fill(false);
  if (lastNightHours !== null) hits[6] = lastNightHours >= SLEEP_TARGET_HOURS;
  return hits;
}

export default function Progress() {
  const { colors, instrument, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<(typeof RANGES)[number]>("1W");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [metricKey, setMetricKey] = useState<CompositionMetricKey>("weight_kg");
  const dashboard = useDashboard(today());
  const profile = useProfile();
  const series = useWeightSeries(range);
  const health = useHealth();
  const avgIntake = useAvgIntake7d(today());
  const { system } = useUnits();

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (range switches / refetches update in place here,
  // no re-stagger on those).
  const { reduceMotion } = useMotionPrefs();
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

  const mono = monoStyle(fonts);
  // Sentence case, not engraved — same convention as Diary's "Day total"/"Water"
  // captions and Home's telemetry-cell captions (engraving is reserved for
  // inside the gauge instruments themselves).
  const mutedLabel = { fontSize: 11, color: instrument.mut };
  // Shared by BOTH branches of the weight figure — AnimatedNumber (a raw RN
  // Text) when data has landed and AppText's em-dash before it. They sit in one
  // `alignItems: "baseline"` row, so a line box present on only one of them
  // made the number jump vertically the moment data arrived (kora#177). The
  // lineHeight is stated explicitly because AnimatedNumber cannot derive one.
  // Lume text-shadow (spec: "34px mono figure with lumeText text-shadow") —
  // the same faint backlit glow the gauge instruments give their own
  // engraved numerals, now on Weight's hero figure inside its BezelCluster.
  const weightFigure = {
    fontSize: 34,
    lineHeight: 39,
    fontWeight: "700",
    fontFamily: fonts.mono,
    color: instrument.ink,
    textShadowColor: instrument.lumeText,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  } as const;

  // The weight series' error was never read at all, so a failed fetch fell
  // straight through to the "No weigh-ins yet" empty state below — telling a
  // user with months of weigh-ins that they have none. Same distinction Home
  // draws: "we couldn't load this" is not "you have none".
  const seriesError = series.isError;
  const entries = (series.data ?? []) as WeightEntry[];

  // kora#45: the panel charts ONE metric at a time, picked from the metrics
  // this history actually holds. Nine more charts would have been the other
  // option; nine mostly-empty panels on a screen where most users only ever
  // log weight is not a trade worth making.
  // The weigh-in sheet's seed, which is the WEIGHT regardless of what the
  // chart is showing: the last logged one, or the profile's figure before
  // there is one.
  const latestWeightKg = entries.length ? entries[entries.length - 1].weight_kg : (profile.data?.weight_kg ?? 0);

  const chartable = chartableMetrics(entries);
  // A range switch can drop the selected metric out of the window entirely
  // (body fat logged in March, viewing 1W). Falling back to weight beats
  // charting nothing with a chip still lit.
  const activeKey = chartable.some((m) => m.key === metricKey) ? metricKey : "weight_kg";
  const metric = compositionMetric(activeKey);
  const trend = metricSeries(entries, activeKey);
  const points = trend.points.map((p) => displayNumber(metric, p.value, system));
  const hasChart = points.length >= 2;
  const instrumentChanged = hasInstrumentChange(trend);

  const latest = trend.points[trend.points.length - 1]?.value;
  // Weight falls back to the profile's own figure before the first weigh-in.
  // A composition metric has no such fallback and shows an em dash instead —
  // there is no plausible stand-in for a body fat percentage, and a 0 would
  // read as one.
  const current = latest ?? (activeKey === "weight_kg" ? (profile.data?.weight_kg ?? 0) : undefined);
  const hasCurrent = typeof current === "number" && (activeKey !== "weight_kg" || current > 0);
  const currentShown = hasCurrent ? displayNumber(metric, current as number, system) : null;
  const metricUnit = unitLabel(metric, system);

  // The change is measured over the trailing run of readings from ONE
  // instrument. Across a switch it would report Renpho's 48.9% minus Omron's
  // 25.7% as 23 points of muscle lost — see lastComparableRun.
  const run = lastComparableRun(trend);
  const delta =
    run.length >= 2
      ? displayNumber(metric, run[run.length - 1].value, system) - displayNumber(metric, run[0].value, system)
      : null;
  const deltaText =
    delta !== null
      ? `${delta <= 0 ? "▾" : "▴"} ${formatMetricNumber(metric, Math.abs(delta))}${metricUnit ? ` ${metricUnit}` : ""}`
      : null;
  // Accent-budget demotion (kora ignition Task 8): the delta used to carry
  // the accent unconditionally — Trends now spends its one accent on the
  // chart's endpoint dot, so the delta reads ink when it's moving toward the
  // stated goal and danger when it's moving away (see deltaColor.ts).
  // "maintenance" (and a profile that hasn't loaded yet) has no away
  // direction to judge, so it defaults to ink.
  // deltaColor judges a change against the user's stated GOAL, and the goal is
  // about weight. Nothing in the profile says which way body water or protein
  // ought to move, so every other metric reads plain ink rather than being
  // coloured as progress or loss on an invented direction.
  const deltaTextColor =
    delta !== null && activeKey === "weight_kg"
      ? deltaColor(delta, profile.data?.goal ?? "maintenance", instrument)
      : instrument.ink;

  const dash = dashboard.data;
  const dashError = dashboard.isError;
  const dashPending = !dash && !dashError;
  const streakDays = dash?.streak_days ?? 0;
  const targetKcal = dash?.targets?.kcal ?? 0;

  const energyDays = buildEnergyDays(avgIntake.series, targetKcal);
  // Data-honesty fix (task-11 review, finding 1): `streak_days` is the general
  // logging streak (any day with a logged entry), not a per-day protein-goal
  // hit — the dashboard has no such history. Labeling the panel "Protein
  // goal" while driving it off this scalar overclaimed what the cells show.
  // Relabeled to say what the data actually is.
  const loggingStreakDays = Math.min(Math.max(0, streakDays), 7);
  const loggingStreakHits = trailingStreakHits(streakDays);
  const sleepHits = sleepStreakHits(health.sleep?.lastNightHours ?? null);

  return (
    <ScreenEntrance direction={2}>
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: TAB_BAR_SCROLL_INSET }}>
      <Animated.View entering={enter(0)}>
        <ScreenHeader title="Trends" />
      </Animated.View>

      <View style={{ paddingHorizontal: 16, gap: 16 }}>
        <Animated.View entering={enter(1)}>
          {/* Trends' one BezelCluster hero (spec: "Weight panel becomes the
              screen's BezelCluster") — Weight is the panel other Trends
              content orbits, same "one bezel-grade instrument per screen"
              rule Home and Diary already follow for their own heroes. */}
          <BezelCluster radius={26} glow>
            <View style={{ padding: 18 }}>
            {/* The hero figure follows the CHARTED metric, so the number and
                the line below it are always the same quantity. It stays
                pressable-to-log only while that metric is weight — "tap to log
                weight" under a body-fat figure would be a lie about what the
                tap does. */}
            <PressableScale
              accessibilityRole={activeKey === "weight_kg" ? "button" : "none"}
              accessibilityLabel={activeKey === "weight_kg" ? "Log weight" : undefined}
              haptic="selection"
              disabled={activeKey !== "weight_kg"}
              onPress={() => setSheetOpen(true)}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <View>
                  <AppText maxFontSizeMultiplier={1.5} style={engravedStyle(instrument)}>{metric.label}</AppText>
                  <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 }}>
                    {currentShown !== null ? (
                      <AnimatedNumber
                        value={currentShown}
                        format={(n) => formatMetricNumber(metric, n)}
                        style={weightFigure}
                      />
                    ) : (
                      <AppText style={weightFigure}>—</AppText>
                    )}
                    {/* Nothing at all for the visceral rating: it is a vendor
                        rating, and a unit beside it — any unit — misstates it. */}
                    {metricUnit ? (
                      <AppText style={{ fontSize: 14, color: instrument.mut }}>{metricUnit}</AppText>
                    ) : null}
                  </View>
                </View>
                {deltaText ? (
                  <AppText style={[{ fontSize: 13, fontWeight: "700", color: deltaTextColor }, mono]}>{deltaText}</AppText>
                ) : null}
              </View>
            </PressableScale>

            {hasChart ? (
              <>
                <WeightChart points={points} breaksAfter={trend.breaksAfter} />
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
                  {/* The CHARTED metric's own first and last dates, which are
                      not the weigh-ins' whenever a metric was logged less
                      often than weight was. */}
                  <AppText style={[mutedLabel, mono]}>{shortDate(trend.points[0].loggedAt)}</AppText>
                  <AppText style={[mutedLabel, mono]}>
                    {shortDate(trend.points[trend.points.length - 1].loggedAt)}
                  </AppText>
                </View>
                {instrumentChanged ? (
                  // The break is drawn; this says what it means. Without the
                  // sentence a reader sees a gap and reads a slope across it,
                  // which is the failure the split exists to prevent.
                  <AppText testID="instrument-change-note" style={[mutedLabel, { marginTop: 6 }]}>
                    {`Measured by ${trend.sources.map(sourceLabel).join(", then ")}. Shown as separate lines — the two don't measure this the same way.`}
                  </AppText>
                ) : null}
              </>
            ) : seriesError ? (
              <LoadErrorNotice message="Couldn't load your weigh-ins." onRetry={() => void series.refetch()} />
            ) : entries.length === 0 ? (
              <EmptyState
                icon="chart-line"
                title="No weigh-ins yet"
                subtitle="Log your weight to see your trend."
                cta={{ label: "Log weight", onPress: () => setSheetOpen(true) }}
                variant="instrument"
              />
            ) : (
              <AppText style={[mutedLabel, { fontSize: 13, paddingVertical: 16, textAlign: "center" }]}>
                {`Log ${metric.label.toLowerCase()} once more to see a trend.`}
              </AppText>
            )}

            {/* Only shown once there is more than weight to chart, so a
                weight-only history sees no picker rather than nine chips that
                all lead to an empty panel. */}
            {chartable.length > 1 ? (
              <View style={{ marginTop: 14 }}>
                <MetricChips metrics={chartable} value={activeKey} onChange={setMetricKey} />
              </View>
            ) : null}

            <View style={{ marginTop: 14 }}>
              <SegmentedGlass options={RANGE_OPTIONS} value={range} onChange={(key) => setRange(key as (typeof RANGES)[number])} />
            </View>

            </View>
          </BezelCluster>
        </Animated.View>

        <Animated.View entering={enter(2)}>
          <GlassPanel radius={22} style={{ padding: 16 }}>
            <AppText style={mutedLabel}>Energy vs budget</AppText>
            <View style={{ marginTop: 10 }}>
              <EnergyBars days={energyDays} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: instrument.tickLit, opacity: 0.72 }} />
                <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 10, color: instrument.mut }}>In-budget</AppText>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: instrument.accent }} />
                <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 10, color: instrument.mut }}>Over</AppText>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{ width: 10, height: 0, borderTopWidth: 1.5, borderStyle: "dashed", borderColor: instrument.tick }} />
                <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 10, color: instrument.mut }}>Target</AppText>
              </View>
            </View>
          </GlassPanel>
        </Animated.View>

        <Animated.View entering={enter(3)} style={{ flexDirection: "row", gap: 12 }}>
          <GlassPanel radius={20} style={{ flex: 1, padding: 14 }}>
            <AppText style={mutedLabel}>Logging streak</AppText>
            {/* A row of unlit cells reads as "you logged nothing this week",
                which is a claim about days we could not load — so on error the
                cells go entirely, replaced by the notice. */}
            {dashError ? (
              <LoadErrorNotice message="Couldn't load your streak." onRetry={() => void dashboard.refetch()} />
            ) : (
              <>
                <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}>
                  {dashPending ? "—" : `${loggingStreakDays}/7 days`}
                </AppText>
                <View style={{ marginTop: 10 }}>
                  <StreakCells hits={loggingStreakHits} testIDPrefix="logging-streak" />
                </View>
              </>
            )}
          </GlassPanel>
          <GlassPanel radius={20} style={{ flex: 1, padding: 14 }}>
            <AppText style={mutedLabel}>Avg sleep</AppText>
            {health.sleep ? (
              <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}>
                {`${health.sleep.lastNightHours}h`}
              </AppText>
            ) : (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Connect Apple Health"
                haptic="selection"
                onPress={health.connect}
                style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}
              >
                <Icon name="heart" size={14} color={instrument.mut} />
                <AppText style={{ fontSize: 12, color: instrument.mut }}>Connect Apple Health</AppText>
              </PressableScale>
            )}
            <View style={{ marginTop: 10 }}>
              <StreakCells hits={sleepHits} testIDPrefix="sleep-streak" />
            </View>
          </GlassPanel>
        </Animated.View>
      </View>

      <LogWeightSheet
        visible={sheetOpen}
        // Still the WEIGHT, whichever metric the chart is showing.
        initialKg={latestWeightKg}
        heightCm={profile.data?.height_cm}
        onClose={() => setSheetOpen(false)}
      />
      </ScrollView>
    </View>
    </ScreenEntrance>
  );
}
