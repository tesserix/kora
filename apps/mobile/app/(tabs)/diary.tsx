import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { GroupedSection, Row } from "@/components/GroupedList";
import { CopyDaySheet } from "@/components/diary/CopyDaySheet";
import { useDashboard, useDayLogs, useAddWater, useDeleteLog } from "@/api/hooks";
import { AnimatedNumber, PressableScale, haptics, springs } from "@/motion";
import { useTheme } from "@/theme";
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
  const { colors } = useTheme();
  const scale = useSharedValue(selected ? 1 : 0);

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
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent }, circleStyle]}
        />
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

export default function Diary() {
  const { colors, spacing, radius } = useTheme();
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
  const total = Math.round(d?.consumed.kcal ?? 0);
  const remaining = Math.max(0, Math.round((d?.targets.kcal ?? 0) - (d?.consumed.kcal ?? 0)));
  const waterL = (d?.water_ml ?? 0) / 1000;
  const logged = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({ pathname: "/meal", params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: timeOf(log.logged_at), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) } });

  const slots = SLOT_ORDER.map((slot) => ({ slot, items: logged.filter((l) => l.meal_slot === slot) })).filter(
    (group) => group.items.length > 0,
  );

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 140 }}>
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
            <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <AnimatedStat label="Total" value={total} unit="kcal" />
              <View style={{ height: 40, width: 1, backgroundColor: colors.separator }} />
              <AnimatedStat label="Remaining" value={remaining} unit="kcal" />
              <View style={{ height: 40, width: 1, backgroundColor: colors.separator }} />
              <AnimatedStat label="Water" value={waterL} unit="L" format={(n) => n.toFixed(1)} />
            </Card>
          </Animated.View>

          <Animated.View entering={enter(3)} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <AppText variant="footnote" muted style={{ marginRight: "auto" }}>
              Add water
            </AppText>
            {[250, 500].map((ml) => (
              <Button
                key={ml}
                title={`+${ml} ml`}
                accessibilityLabel={`Add ${ml} ml water`}
                disabled={addWater.isPending}
                onPress={() => addWaterMl(ml)}
                style={{ minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.full }}
              />
            ))}
          </Animated.View>
          {waterErr ? (
            <AppText style={{ color: colors.destructive, marginBottom: 12 }}>{waterErr}</AppText>
          ) : null}

          {slots.map((group, gi) => (
            <Animated.View key={group.slot} entering={enter(4 + gi)}>
              <GroupedSection header={group.slot.toUpperCase()} style={{ marginBottom: 16 }}>
                {group.items.map((log) => (
                  <Swipeable
                    key={log.id}
                    overshootRight={false}
                    renderRightActions={() => (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${log.description}`}
                        onPress={() => confirmDelete(log.id)}
                        style={{ backgroundColor: colors.destructive, justifyContent: "center", alignItems: "center", width: 74 }}
                      >
                        <Icon name="trash-2" size={20} color={colors.destructiveForeground} />
                      </Pressable>
                    )}
                  >
                    <Row
                      title={log.description}
                      subtitle={`${Math.round(log.quantity_grams)}g · ${timeOf(log.logged_at)}`}
                      detail={`${Math.round(log.kcal)} kcal`}
                      chevron
                      onPress={() => openMeal(log)}
                    />
                  </Swipeable>
                ))}
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
    </>
  );
}
