import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { AppBackground } from "@/components/AppBackground";
import { Icon } from "@/components/Icon";
import { GroupedSection, Row } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { Badge } from "@/components/Badge";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { CopyDaySheet } from "@/components/diary/CopyDaySheet";
import { QueuedFailedSheet } from "@/components/diary/QueuedFailedSheet";
import { EmptyState } from "@/components/common/EmptyState";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { useDashboard, useDayLogs, useAddWater, useDeleteLog } from "@/api/hooks";
import { useQueuedLogs } from "@/offline/useQueuedLogs";
import { useQueuedCaptures } from "@/offline/useQueuedCaptures";
import { PressableScale, haptics } from "@/motion";
import { useTheme } from "@/theme";
import { hslToHex, withAlpha } from "@/lib/color";
import { useUnits, mlToFlOz, flOzToMl, type UnitSystem } from "@/units";
import { formatPortion } from "@/units/portion";
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
  hitGoal: boolean;
  onSelect: () => void;
};

// A single week-strip day per the instrument-glass spec (§Screens.2): weekday
// caption + mono day number + a 4pt goal-hit pip. The selected day gets the
// "glass cell" look (instrument.glass fill + glassBorder ring) — no other
// affordance distinguishes it, so this is load-bearing, not decorative.
function WeekDayCell({ date, dow, selected, today, hitGoal, onSelect }: WeekDayCellProps) {
  const { instrument, fonts } = useTheme();
  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };
  const dISO = iso(date);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={dISO}
      accessibilityState={{ selected }}
      haptic="selection"
      onPress={onSelect}
      testID={`week-cell-${dISO}`}
      style={{
        flex: 1,
        alignItems: "center",
        gap: 5,
        paddingVertical: 8,
        borderRadius: 14,
        backgroundColor: selected ? instrument.glass : "transparent",
        borderWidth: selected ? StyleSheet.hairlineWidth : 0,
        borderColor: instrument.glassBorder,
      }}
    >
      <AppText style={{ fontSize: 11, color: instrument.mut }}>{dow}</AppText>
      <AppText style={[{ fontSize: 15, fontWeight: "600", color: today || selected ? instrument.ink : instrument.mut }, mono]}>
        {date.getDate()}
      </AppText>
      <View
        testID={`week-pip-${dISO}`}
        style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: hitGoal ? instrument.accent : instrument.tick }}
      />
    </PressableScale>
  );
}

type WaterPillProps = { label: string; a11yLabel: string; disabled: boolean; onPress: () => void };

// Green-turned-accent pill matching the mock's `.waterbtns`. `label` ("+250 ml"
// / "+8 fl oz") and `a11yLabel` ("Add 250 ml water" / "Add 8 fl oz water") are
// unit-aware and load-bearing for tests.
function WaterPill({ label, a11yLabel, disabled, onPress }: WaterPillProps) {
  const { instrument } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
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
        backgroundColor: withAlpha(instrument.accent, 0.16),
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <AppText style={{ color: instrument.accent, fontWeight: "700" }}>{label}</AppText>
    </PressableScale>
  );
}

type WaterQuickAdd = { ml: number; label: string; a11yLabel: string };

// Quick-add amounts per unit system. Metric: 250/500 ml. Imperial: a cup (8 fl oz)
// and a large glass (16 fl oz), stored as their rounded ml equivalents (the backend
// is always ml). Metric labels/a11y are preserved verbatim for existing tests.
const WATER_QUICK_ADDS: Record<UnitSystem, readonly WaterQuickAdd[]> = {
  metric: [
    { ml: 250, label: "+250 ml", a11yLabel: "Add 250 ml water" },
    { ml: 500, label: "+500 ml", a11yLabel: "Add 500 ml water" },
  ],
  imperial: [
    { ml: Math.round(flOzToMl(8)), label: "+8 fl oz", a11yLabel: "Add 8 fl oz water" },
    { ml: Math.round(flOzToMl(16)), label: "+16 fl oz", a11yLabel: "Add 16 fl oz water" },
  ],
};

export default function Diary() {
  const { colors, spacing, instrument, fonts } = useTheme();
  const { system } = useUnits();
  const insets = useSafeAreaInsets();
  const week = weekDates();
  const todayIso = iso(new Date());
  const [selected, setSelected] = useState(todayIso);
  const dashboard = useDashboard(selected);
  const logs = useDayLogs(selected);
  // Writes made offline live only on this device until a drain lands, so the
  // diary reads them straight off the queue and renders them beside the
  // server's own rows.
  const queued = useQueuedLogs(selected);
  // Photo/voice captures still waiting on identification. Distinct from
  // `queued` above: a capture has no macros of its own until a drain
  // resolves it (or the user confirms a review suggestion), so it never
  // contributes to the day total — see the `kcal: null` invariant on
  // useQueuedCaptures.
  const captures = useQueuedCaptures(selected);
  const addWater = useAddWater();
  const deleteLog = useDeleteLog();
  const { openCompose } = useSavedMealEditor();
  const [waterErr, setWaterErr] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [failedRowId, setFailedRowId] = useState<string | null>(null);
  // Selection is scoped to the day on screen, which is also the only day this
  // screen has loaded. Composing NEVER edits the underlying logs — it
  // bookmarks a combination for future logging.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selecting = selectedIds.length > 0;
  const toggleSelected = (id: string) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Selection holds log ids from the day it was made, and only that day's rows
  // are on screen — carrying it across a day change leaves a header claiming
  // "1 selected" with nothing selected in front of the user, and a "Save as
  // meal" that filters to zero rows and opens a blank sheet.
  const selectDay = (day: string) => {
    setSelected(day);
    setSelectedIds([]);
  };

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
      {
        text: "Delete",
        style: "destructive",
        // This was the one delete in the app with no error surface — meal.tsx's
        // identical flow has had one all along. It fails by leaving the row
        // exactly where it was, which the user cannot tell apart from nothing
        // having happened; and a delete that failed also leaves any queued copy
        // of this id in place (see useDeleteLog), so the meal is still live.
        onPress: () =>
          deleteLog.mutate(id, {
            onError: () => Alert.alert("Couldn't delete", "Please try again."),
          }),
      },
    ]);
  };

  const logged = (logs.data ?? []) as FoodLog[];

  // Reads the already-logged rows and seeds the compose sheet — no delete, no
  // edit, no navigation on the selected rows themselves.
  const saveSelectionAsMeal = () => {
    const chosen = logged.filter((l) => selectedIds.includes(l.id));
    setSelectedIds([]);
    openCompose(
      chosen.map((l) => ({
        food_item_id: l.food_item_id ?? "",
        name: l.description,
        quantity_grams: l.quantity_grams,
        entered_amount: l.entered_amount ?? null,
        entered_unit: l.entered_unit ?? null,
        base_unit: l.base_unit ?? null,
        // The slot these rows were eaten in — composing two dinner entries and
        // saving them under Breakfast is a silent mislabel the user only ever
        // sees later, when the saved meal logs itself into the wrong slot.
        meal_slot: l.meal_slot,
      })),
    );
  };

  // The client mints ONE id and uses it as both the queue item id and the
  // server row id (see useCreateLog), so a queued item the server has already
  // applied shares its id with the row that came back. Two ordinary paths
  // leave the queue in that state: a POST that died after the server wrote the
  // row, and a drain whose response was lost. Both stay that way until the
  // next drain replays the id idempotently and clears the queue — and in the
  // meantime the meal is in BOTH lists. Showing it twice, and counting it
  // twice, is exactly what this feature exists to prevent, so the shared id is
  // used to drop the queued copy the moment the server row exists.
  //
  // Everything below reads this list rather than queued.rows, so the rendered
  // rows and the day total can never disagree about which meals are pending.
  const serverLogIds = new Set(logged.map((l) => l.id));
  const queuedNotOnServer = queued.rows.filter((r) => !serverLogIds.has(r.id));

  // A queued row the user tapped, resolved from the live rows rather than
  // captured on tap, so a drain that lands mid-sheet cannot leave stale copy
  // on screen.
  const failedRow = queuedNotOnServer.find((r) => r.id === failedRowId) ?? null;

  // Retry and Discard both dismiss the sheet immediately, so a rejected
  // storage write would otherwise look exactly like a successful one — the row
  // simply unchanged, with nothing said. Same confirm-Alert surface the delete
  // flow above uses.
  const runQueueAction = (action: () => Promise<void>) => {
    setFailedRowId(null);
    action().catch(() => Alert.alert("Couldn't update that item", "Please try again."));
  };

  const d = dashboard.data;
  // No dashboard data yet and no error means the query hasn't resolved — distinct
  // from a resolved dashboard with genuinely zero consumption, which must still
  // show real "0" figures, not a placeholder. Same guard as Home (index.tsx).
  const pending = !d && !dashboard.isError;
  const goal = d?.targets.kcal ?? 0;
  // Pending only. A pending item is a real food with known nutrition whose
  // upload is merely outstanding, so leaving it out makes remaining-calories
  // wrong exactly when the user is relying on it; a failed item is never
  // landing, so counting it would overstate the day indefinitely. A null kcal
  // (food evicted from the offline cache) contributes nothing — it is unknown,
  // not zero, and the row says so.
  const queuedKcal = queuedNotOnServer.reduce(
    (sum, r) => (r.status === "pending" ? sum + (r.kcal ?? 0) : sum),
    0,
  );
  const consumedKcal = (d?.consumed.kcal ?? 0) + queuedKcal;
  const total = Math.round(consumedKcal);
  const remaining = Math.max(0, Math.round(goal - consumedKcal));
  const waterMl = d?.water_ml ?? 0;
  const water =
    system === "imperial"
      ? { value: mlToFlOz(waterMl), unit: "fl oz" }
      : { value: waterMl / 1000, unit: "L" };
  const waterQuickAdds = WATER_QUICK_ADDS[system];
  const pct = goal > 0 ? Math.min(100, Math.round((total / goal) * 100)) : 0;
  // Only the day actually on screen has real consumed/target data — the other
  // six week-strip cells have none of it loaded (this screen fetches one day
  // at a time, unchanged), so their pip stays unlit rather than guessing.
  const hitGoal = !pending && goal > 0 && total >= goal;

  const openMeal = (log: FoodLog) =>
    router.push({ pathname: "/meal", params: { id: log.id, name: log.description, mealSlot: log.meal_slot, time: timeOf(log.logged_at), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)), grams: String(Math.round(log.quantity_grams)) } });

  // A slot can be present because of a queued row alone — logging the day's
  // only lunch offline must still produce a LUNCH section.
  const slots = SLOT_ORDER.map((slot) => ({
    slot,
    items: logged.filter((l) => l.meal_slot === slot),
    queued: queuedNotOnServer.filter((r) => r.mealSlot.toLowerCase() === slot),
    captures: captures.rows.filter((r) => r.mealSlot.toLowerCase() === slot),
  })).filter((group) => group.items.length > 0 || group.queued.length > 0 || group.captures.length > 0);

  const slotKcal = (group: (typeof slots)[number]) =>
    Math.round(
      group.items.reduce((sum, l) => sum + l.kcal, 0) +
        group.queued.reduce((sum, r) => sum + (r.status === "pending" ? (r.kcal ?? 0) : 0), 0),
    );

  const isEmptyDay = logged.length === 0 && queuedNotOnServer.length === 0 && captures.rows.length === 0;
  // The ghost row nudges toward the next unlogged slot, in canonical order —
  // it never appears once every slot has something, and never fabricates a
  // reserve figure before the dashboard has resolved.
  const missingSlot = !pending && !isEmptyDay ? SLOT_ORDER.find((slot) => !slots.some((g) => g.slot === slot)) : undefined;

  const mono = { fontFamily: fonts.mono, fontVariant: ["tabular-nums" as const] };
  // The four slot headers below (Breakfast/Lunch/Dinner/Snack, at most) ARE
  // this screen's engraved zone (spec's ~4-visible-label budget) — every other
  // caption on this screen is sentence-case muted text, not engraved.
  const engraved = {
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: "uppercase" as const,
    fontWeight: "600" as const,
    color: instrument.mut,
  };
  const mutedLabel = { fontSize: 11, color: instrument.mut };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 140 }}>
        <Animated.View entering={enter(0)} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <AppText variant="largeTitle">Diary</AppText>
        </Animated.View>

        {selecting ? (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 }}>
            <AppText>{`${selectedIds.length} selected`}</AppText>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Pressable accessibilityRole="button" onPress={() => setSelectedIds([])}>
                <AppText>Cancel</AppText>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={saveSelectionAsMeal}>
                <AppText style={{ color: instrument.accent }}>Save as meal</AppText>
              </Pressable>
            </View>
          </View>
        ) : null}

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
                hitGoal={dISO === selected && hitGoal}
                onSelect={() => selectDay(dISO)}
              />
            );
          })}
        </Animated.View>

        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <Animated.View entering={enter(2)}>
            <GlassPanel radius={20} style={{ marginBottom: 16 }} testID="day-total">
              <View style={{ padding: 16 }}>
                <AppText style={mutedLabel}>Day total</AppText>
                {pending ? (
                  <AppText style={[{ fontSize: 22, color: instrument.mut, marginTop: 4 }, mono]}>—</AppText>
                ) : (
                  <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
                    <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>{total}</AppText>
                    <AppText style={[{ fontSize: 13, color: instrument.mut }, mono]}>{` / ${goal} kcal`}</AppText>
                  </View>
                )}
                <View style={{ height: 6, borderRadius: 3, backgroundColor: instrument.inset, overflow: "hidden", marginTop: 10 }}>
                  <View style={{ height: "100%", width: `${pending ? 0 : pct}%`, backgroundColor: instrument.accent, borderRadius: 3 }} />
                </View>

                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
                  <View>
                    <AppText style={mutedLabel}>Water</AppText>
                    <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}>
                      {pending ? "—" : `${system === "imperial" ? Math.round(water.value) : water.value.toFixed(1)} ${water.unit}`}
                    </AppText>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, flex: 1, marginLeft: 16 }}>
                    {waterQuickAdds.map((qa) => (
                      <WaterPill
                        key={qa.ml}
                        label={qa.label}
                        a11yLabel={qa.a11yLabel}
                        disabled={addWater.isPending}
                        onPress={() => addWaterMl(qa.ml)}
                      />
                    ))}
                  </View>
                </View>
                {waterErr ? (
                  <AppText style={{ color: colors.destructive, marginTop: 8 }}>{waterErr}</AppText>
                ) : null}
              </View>
            </GlassPanel>
          </Animated.View>

          {slots.map((group, gi) => (
            <Animated.View key={group.slot} entering={enter(4 + gi)}>
              <GlassPanel radius={20} style={{ marginBottom: 16 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, paddingBottom: 8 }}>
                  <AppText style={engraved}>{group.slot.toUpperCase()}</AppText>
                  <AppText style={[{ fontSize: 13, fontWeight: "600", color: instrument.ink }, mono]}>
                    {`${slotKcal(group)} kcal`}
                  </AppText>
                </View>
                {group.captures.map((c) => {
                  const failed = c.status === "failed";
                  const pendingCapture = c.status === "pending";
                  const statusText = pendingCapture
                    ? "Identifying when you're back online"
                    : c.status === "review"
                      ? "Tap to confirm"
                      : "Couldn't identify";
                  const name = c.kind === "photo" ? "Photo" : "Voice note";
                  return (
                    <MealRow
                      key={c.id}
                      name={name}
                      slot={statusText}
                      kcal={c.kcal}
                      iconName={c.kind === "photo" ? "camera" : "mic"}
                      dimmed={failed}
                      badge={
                        pendingCapture ? (
                          <ActivityIndicator size="small" color={colors.tertiaryLabel} />
                        ) : (
                          <Badge variant="neutral">{failed ? "Failed" : "Review"}</Badge>
                        )
                      }
                      accessibilityLabel={`${name}, ${statusText}`}
                      // Failed and review both point at capture-review now: a
                      // failed capture is kept WITH its media there (thumbnail
                      // or playback, the failure reason, manual logging, and
                      // discard) rather than a retry/discard-only sheet, so
                      // the media never vanishes without the user seeing it.
                      onPress={
                        failed || c.status === "review"
                          ? () => router.push({ pathname: "/capture-review", params: { id: c.id } })
                          : undefined
                      }
                    />
                  );
                })}
                {group.queued.map((r) => {
                  const fv = foodVisual(r.description);
                  const failed = r.status === "failed";
                  return (
                    <MealRow
                      key={r.id}
                      name={r.description}
                      slot={failed ? "Couldn't sync" : "Waiting to sync"}
                      kcal={r.kcal}
                      iconName={fv.icon}
                      tint={hslToHex(fv.hue, 0.5, 0.5)}
                      dimmed={failed}
                      badge={<Badge variant="neutral">{failed ? "Failed" : "Pending"}</Badge>}
                      accessibilityLabel={`${r.description}, ${failed ? "failed to sync" : "waiting to sync"}`}
                      onPress={failed ? () => setFailedRowId(r.id) : undefined}
                    />
                  );
                })}
                {group.items.map((log) => {
                  const fv = foodVisual(log.description);
                  // Always a boolean (never undefined) on these rows: this
                  // screen HAS a selection mode, so an unselected row has to
                  // say so rather than stay silent.
                  const rowSelected = selectedIds.includes(log.id);
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
                      <View>
                        <MealRow
                          name={log.description}
                          slot={`${formatPortion({ quantity_grams: log.quantity_grams, entered_amount: log.entered_amount, entered_unit: log.entered_unit, base_unit: log.base_unit })} · ${timeOf(log.logged_at)}`}
                          kcal={log.kcal}
                          iconName={fv.icon}
                          tint={hslToHex(fv.hue, 0.5, 0.5)}
                          onPress={() => (selecting ? toggleSelected(log.id) : openMeal(log))}
                          onLongPress={() => toggleSelected(log.id)}
                          selected={rowSelected}
                          accessibilityLabel={log.description}
                        />
                      </View>
                    </Swipeable>
                  );
                })}
              </GlassPanel>
            </Animated.View>
          ))}

          {missingSlot ? (
            <Animated.View entering={enter(4 + slots.length)}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`Add ${missingSlot}`}
                haptic="selection"
                onPress={() => router.push("/capture")}
                style={{
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: instrument.tick,
                  borderRadius: 24,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                <Icon name="plus" size={16} color={instrument.accent} />
                <AppText style={{ color: instrument.mut }}>
                  {`Add ${missingSlot} · ${remaining} kcal in reserve`}
                </AppText>
              </PressableScale>
            </Animated.View>
          ) : null}

          {isEmptyDay ? (
            <Animated.View entering={enter(4)}>
              <EmptyState
                icon="book-open"
                title="Nothing logged"
                subtitle="Meals you log on this day appear here."
              />
              <GroupedSection>
                <Row title="Copy from another day" icon={{ name: "repeat", tint: colors.accent }} onPress={() => setCopyOpen(true)} />
              </GroupedSection>
            </Animated.View>
          ) : null}
        </View>
      </ScrollView>
      {copyOpen ? <CopyDaySheet visible targetDate={selected} onClose={() => setCopyOpen(false)} /> : null}
      {failedRow ? (
        <QueuedFailedSheet
          visible
          description={failedRow.description}
          onRetry={() => runQueueAction(() => queued.retryRow(failedRow.id))}
          onDiscard={() => runQueueAction(() => queued.discardRow(failedRow.id))}
          onClose={() => setFailedRowId(null)}
        />
      ) : null}
    </View>
  );
}
