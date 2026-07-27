import { useEffect, useId, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { AppBackground } from "@/components/AppBackground";
import { Card } from "@/components/Card";
import { Numeral } from "@/components/Numeral";
import { Icon } from "@/components/Icon";
import { GroupedSection, Row } from "@/components/GroupedList";
import { GaugeRing } from "@/components/GaugeRing";
import { MealRow } from "@/components/MealRow";
import { CopyDaySheet } from "@/components/diary/CopyDaySheet";
import { useDashboard, useDayLogs, useAddWater, useDeleteLog } from "@/api/hooks";
import { AnimatedNumber, PressableScale, haptics, springs } from "@/motion";
import { useTheme } from "@/theme";
import { hslToHex, withAlpha } from "@/lib/color";
import { foodVisual } from "@/lib/foodVisual";
import type { FoodLog } from "@/api/types";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"];

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

type WeekDayCellProps = {
  date: Date;
  dow: string;
  selected: boolean;
  today: boolean;
  loggable: boolean;
  onSelect: () => void;
};

// A single week-strip day: accent-filled circle springs in on selection,
// today (unselected) gets a ring outline, and the loggable dot is preserved.
function WeekDayCell({ date, dow, selected, today, loggable, onSelect }: WeekDayCellProps) {
  const { colors, gradients } = useTheme();
  const scale = useSharedValue(selected ? 1 : 0);
  const gradientId = useId();

  useEffect(() => {
    scale.value = withSpring(selected ? 1 : 0, springs.lively);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const circleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={iso(date)}
      accessibilityState={{ selected }}
      haptic="selection"
      onPress={onSelect}
      style={{ flex: 1, alignItems: "center", gap: 4, paddingVertical: 4 }}
    >
      <AppText variant="caption" muted>
        {dow}
      </AppText>
      <View style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
        {today && !selected ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: colors.accent }}
          />
        ) : null}
        <Animated.View pointerEvents="none" style={[{ position: "absolute", width: 36, height: 36, borderRadius: 18, overflow: "hidden" }, circleStyle]}>
          <Svg width={36} height={36}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor={gradients.green[0]} />
                <Stop offset="100%" stopColor={gradients.green[1]} />
              </LinearGradient>
            </Defs>
            <Circle cx={18} cy={18} r={18} fill={`url(#${gradientId})`} />
          </Svg>
        </Animated.View>
        <AppText variant="headline" style={{ color: selected ? colors.primaryForeground : colors.label }}>
          {date.getDate()}
        </AppText>
      </View>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 999,
          backgroundColor: loggable ? (selected ? colors.primaryForeground : colors.accent) : "transparent",
        }}
      />
    </PressableScale>
  );
}

type AnimatedStatProps = { label: string; value: number; unit: string; format?: (n: number) => string };

// Stat-shaped layout (label / value+unit) but the value animates via AnimatedNumber —
// the shared Stat component renders a static Numeral, so this is a local composition.
function AnimatedStat({ label, value, unit, format }: AnimatedStatProps) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <AppText variant="footnote" muted>
        {label}
      </AppText>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
        <AnimatedNumber value={value} format={format} style={{ fontSize: 22, fontWeight: "700", letterSpacing: -0.3, color: colors.label }} />
        <AppText variant="footnote" muted>
          {unit}
        </AppText>
      </View>
    </View>
  );
}

type WaterPillProps = { ml: number; disabled: boolean; onPress: () => void };

// Green pill matching the mock's `.waterbtns` — visible "+NNN ml" text and
// "Add NNN ml water" a11y label are both load-bearing for existing tests.
function WaterPill({ ml, disabled, onPress }: WaterPillProps) {
  const { colors } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Add ${ml} ml water`}
      accessibilityState={{ disabled }}
      haptic="impactLight"
      disabled={disabled}
      onPress={onPress}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 13,
        borderRadius: 16,
        backgroundColor: withAlpha(colors.accent, 0.16),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <AppText style={{ color: colors.accent, fontWeight: "700" }}>{`+${ml} ml`}</AppText>
    </PressableScale>
  );
}

export default function Diary() {
  const { colors, spacing, gradients } = useTheme();
  const insets = useSafeAreaInsets();
  const week = weekDates();
  const todayIso = iso(new Date());
  const [selected, setSelected] = useState(todayIso);
  const dashboard = useDashboard(selected);
  const logs = useDayLogs(selected);
  const addWater = useAddWater();
  const deleteLog = useDeleteLog();
  const [waterErr, setWaterErr] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);

  // Entrance stagger runs on first mount only — see app/(tabs)/index.tsx for the
  // same guard and rationale (refetches update data in place, no re-stagger).
  const firstMount = useRef(true);
  useEffect(() => {
    firstMount.current = false;
  }, []);
  const enter = (i: number) => (firstMount.current ? FadeInDown.duration(300).delay(i * 30) : undefined);

  const addWaterMl = (volume_ml: number) => {
    setWaterErr(null);
    addWater.mutate(
      { volume_ml, logged_at: `${selected}T12:00:00Z` },
      {
        onSuccess: () => haptics.success(),
        onError: () => setWaterErr("Couldn't add water. Try again."),
      },
    );
  };

  // Same confirm-Alert → useDeleteLog flow as app/meal.tsx's onDelete (identical
  // copy + payload), shared here between the swipe action and (if added later) any
  // other delete entry point on this screen.
  const confirmDelete = (id: string) => {
    Alert.alert("Delete this entry?", "This removes it from your diary.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => deleteLog.mutate(id) },
    ]);
  };

  const d = dashboard.data;
  const goal = d?.targets.kcal ?? 0;
  const total = Math.round(d?.consumed.kcal ?? 0);
  const remaining = Math.max(0, Math.round(goal - (d?.consumed.kcal ?? 0)));
  const waterL = (d?.water_ml ?? 0) / 1000;
  const pct = goal > 0 ? Math.round((total / goal) * 100) : 0;
  const logged = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({ pathname: "/meal", params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: timeOf(log.logged_at), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) } });

  const slots = SLOT_ORDER.map((slot) => ({ slot, items: logged.filter((l) => l.meal_slot === slot) })).filter(
    (group) => group.items.length > 0,
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 140 }}>
        <Animated.View entering={enter(0)} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <AppText variant="largeTitle">Diary</AppText>
        </Animated.View>

        <Animated.View entering={enter(1)} style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
          {week.map((date) => {
            const dISO = iso(date);
            return (
              <WeekDayCell
                key={dISO}
                date={date}
                dow={DOW[date.getDay()]}
                selected={dISO === selected}
                today={dISO === todayIso}
                loggable={dISO <= todayIso}
                onSelect={() => setSelected(dISO)}
              />
            );
          })}
        </Animated.View>

        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <Animated.View entering={enter(2)}>
            <Card variant="hero" style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 20 }}>
                <GaugeRing value={total} max={goal} size={96} stroke={11} gradient={gradients.green}>
                  <Numeral size={24}>{`${pct}%`}</Numeral>
                </GaugeRing>
                <View style={{ flex: 1, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }}>
                  <AnimatedStat label="Eaten" value={total} unit="kcal" />
                  <AnimatedStat label="Left" value={remaining} unit="kcal" />
                  <AnimatedStat label="Water" value={waterL} unit="L" format={(n) => n.toFixed(1)} />
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 8, marginTop: 16 }}>
                {[250, 500].map((ml) => (
                  <WaterPill key={ml} ml={ml} disabled={addWater.isPending} onPress={() => addWaterMl(ml)} />
                ))}
              </View>
              {waterErr ? (
                <AppText style={{ color: colors.destructive, marginTop: 8 }}>{waterErr}</AppText>
              ) : null}
            </Card>
          </Animated.View>

          {slots.map((group, gi) => (
            <Animated.View key={group.slot} entering={enter(4 + gi)}>
              <GroupedSection elevated header={group.slot.toUpperCase()} style={{ marginBottom: 16 }}>
                {group.items.map((log) => {
                  const fv = foodVisual(log.description);
                  return (
                    <Swipeable
                      key={log.id}
                      overshootRight={false}
                      renderRightActions={() => (
                        <PressableScale
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${log.description}`}
                          haptic="none"
                          onPress={() => confirmDelete(log.id)}
                          style={{ backgroundColor: colors.destructive, justifyContent: "center", alignItems: "center", width: 74 }}
                        >
                          <Icon name="trash-2" size={20} color={colors.destructiveForeground} />
                        </PressableScale>
                      )}
                    >
                      <View style={{ paddingHorizontal: spacing.md, backgroundColor: colors.elevated }}>
                        <MealRow
                          name={log.description}
                          slot={`${Math.round(log.quantity_grams)}g · ${timeOf(log.logged_at)}`}
                          kcal={log.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => openMeal(log)}
                          accessibilityLabel={log.description}
                        />
                      </View>
                    </Swipeable>
                  );
                })}
              </GroupedSection>
            </Animated.View>
          ))}

          {logged.length === 0 ? (
            <Animated.View entering={enter(4)}>
              <AppText muted style={{ marginBottom: 8 }}>
                Nothing logged this day.
              </AppText>
              <GroupedSection>
                <Row title="Copy from another day" icon={{ name: "repeat", tint: colors.accent }} onPress={() => setCopyOpen(true)} />
              </GroupedSection>
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>
      {copyOpen ? <CopyDaySheet visible targetDate={selected} onClose={() => setCopyOpen(false)} /> : null}
    </View>
  );
}
