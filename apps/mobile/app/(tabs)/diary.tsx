import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { AppBackground } from "@/components/AppBackground";
import { Icon } from "@/components/Icon";
import { GroupedSection, Row } from "@/components/GroupedList";
import { MealRow } from "@/components/MealRow";
import { Badge } from "@/components/Badge";
import { ZoneRule } from "@/components/instrument/BezelCluster";
import { WeekRail, type WeekRailDay } from "@/components/diary/WeekRail";
import { DayTotalCluster, WATER_QUICK_ADDS } from "@/components/diary/DayTotalCluster";
import { formatSlotLabel } from "@/components/diary/slotLabel";
import { CopyDaySheet } from "@/components/diary/CopyDaySheet";
import { QueuedFailedSheet } from "@/components/diary/QueuedFailedSheet";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { useSavedMealEditor } from "@/components/meals/SavedMealSheetProvider";
import { useDashboard, useDayLogs, useAddWater, useDeleteLog, useCurrentFast, useStartFast, useEndFast } from "@/api/hooks";
import { fastElapsedLabel } from "@/lib/fastingCopy";
import { useQueuedLogs } from "@/offline/useQueuedLogs";
import { useQueuedCaptures } from "@/offline/useQueuedCaptures";
import { useIsOnline } from "@/offline/connectivity";
import { PressableScale, ScreenEntrance, haptics, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";
import { hslToHex } from "@/lib/color";
import { useUnits, mlToFlOz } from "@/units";
import { formatPortion } from "@/units/portion";
import { foodVisual } from "@/lib/foodVisual";
import { accessibleMealLabel } from "@/lib/portionAssumedLabel";
import { now as clockNow } from "@/lib/shotsClock";
import type { FoodLog } from "@/api/types";
import { TAB_BAR_SCROLL_INSET } from "@/components/FloatingTabBar";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const SLOT_ORDER = ["breakfast", "lunch", "dinner", "snack"];

// `now()` rather than `new Date()`: the week strip and the selected day are
// the most date-sensitive thing in the app, and the screenshot harness pins
// them. See src/lib/shotsClock.ts.
function weekDates(): Date[] {
  const now = clockNow();
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
  const { colors, spacing, instrument } = useTheme();
  const { system } = useUnits();
  const insets = useSafeAreaInsets();
  const week = weekDates();
  const todayIso = iso(clockNow());
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
  // A pending capture is only WAITING on connectivity while the device is
  // offline; online it is actively resolving, so the row must not promise a
  // future action. Subscribed rather than sampled so the copy flips with the
  // connection while the row stays mounted.
  const online = useIsOnline();
  const addWater = useAddWater();
  const deleteLog = useDeleteLog();
  const currentFast = useCurrentFast();
  const startFast = useStartFast();
  const endFast = useEndFast();
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
  // Same shape as Home (index.tsx): an explicit error flag, the figures hidden
  // rather than zeroed, and a placeholder while the query is still in flight.
  // The two failures are tracked separately because they lie about different
  // things — a failed dashboard fabricates the day's totals, a failed log fetch
  // fabricates an empty day.
  const dashError = dashboard.isError;
  const logsError = logs.isError;
  const loadError = dashError || logsError;
  // No dashboard data yet and no error means the query hasn't resolved — distinct
  // from a resolved dashboard with genuinely zero consumption, which must still
  // show real "0" figures, not a placeholder. Same guard as Home (index.tsx).
  const pending = !d && !dashError;
  // Neither resolved nor resolvable: both states must render "—", never a
  // figure. `pending` alone was false on error, which is exactly how "0 / 0
  // kcal" and "0.0 L" reached the screen as if they were the user's day.
  const unknownTotals = pending || dashError;
  const retry = () => {
    if (dashError) void dashboard.refetch();
    if (logsError) void logs.refetch();
  };
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
  const hitGoal = !unknownTotals && goal > 0 && total >= goal;

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

  // A failed log fetch is not an empty day. Rendering the first-run empty
  // state there tells a user with a full diary that they logged nothing.
  const isEmptyDay =
    !logsError && logged.length === 0 && queuedNotOnServer.length === 0 && captures.rows.length === 0;
  // The ghost row nudges toward the next unlogged slot, in canonical order —
  // it never appears once every slot has something, and never fabricates a
  // reserve figure before the dashboard has resolved.
  const missingSlot = !loadError && !pending && !isEmptyDay ? SLOT_ORDER.find((slot) => !slots.some((g) => g.slot === slot)) : undefined;

  // Day-total figure, water readout and the per-slot ZoneRule labels (at most
  // four visible at once: Breakfast/Lunch/Dinner/Snack) are this screen's
  // engraved zone (spec's ~4-visible-label budget) — everything else stays
  // sentence-case muted text.
  const waterLabel = unknownTotals
    ? "—"
    : `${system === "imperial" ? Math.round(water.value) : water.value.toFixed(1)} ${water.unit}`;

  const weekDays: WeekRailDay[] = week.map((date) => {
    const dISO = iso(date);
    return {
      date,
      dow: DOW[date.getDay()],
      iso: dISO,
      selected: dISO === selected,
      today: dISO === todayIso,
      hitGoal: dISO === selected && hitGoal,
    };
  });

  return (
    <ScreenEntrance direction={1}>
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: TAB_BAR_SCROLL_INSET }}>
        <Animated.View entering={enter(0)} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <AppText variant="largeTitle">Diary</AppText>
        </Animated.View>

        {selecting ? (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 }}>
            <AppText>{`${selectedIds.length} selected`}</AppText>
            <View style={{ flexDirection: "row", gap: 16 }}>
              <Pressable accessibilityRole="button" onPress={() => setSelectedIds([])} style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}>
                <AppText>Cancel</AppText>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={saveSelectionAsMeal} style={(s) => ({ opacity: s.pressed ? 0.6 : 1 })}>
                <AppText style={{ color: instrument.ink, fontWeight: "600" }}>Save as meal</AppText>
              </Pressable>
            </View>
          </View>
        ) : null}

        <Animated.View entering={enter(1)} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <WeekRail days={weekDays} onSelectDay={selectDay} />
        </Animated.View>

        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          {/* Same explicit-error surface Home carries, with a Retry because this
              screen has no pull-to-refresh to point the copy at. */}
          {loadError ? <LoadErrorNotice message="Couldn't load your day." onRetry={retry} /> : null}
          <Animated.View entering={enter(2)} style={{ marginBottom: 24 }}>
            <DayTotalCluster
              testID="day-total"
              unknownTotals={unknownTotals}
              dashError={dashError}
              total={total}
              goal={goal}
              pct={pending ? 0 : pct}
              waterLabel={waterLabel}
              waterQuickAdds={waterQuickAdds}
              addWaterDisabled={addWater.isPending}
              onAddWater={addWaterMl}
              waterErr={waterErr}
              destructiveColor={colors.destructive}
            />
          </Animated.View>

          {/* Beside the water control: declare or end a fast. Idempotent on the
              server (a double-tap on Start just returns the already-open
              interval), so no local guard against a double press is needed here. */}
          <Animated.View entering={enter(3)} style={{ marginBottom: 20 }}>
            {currentFast.data ? (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="End fast"
                haptic="selection"
                onPress={() => endFast.mutate()}
                style={{
                  borderWidth: 1.5,
                  borderStyle: "solid",
                  borderColor: instrument.tick,
                  borderRadius: 24,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  alignItems: "center",
                }}
              >
                <AppText>{`End fast · ${fastElapsedLabel(currentFast.data.started_at)}`}</AppText>
              </PressableScale>
            ) : (
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Start fast"
                haptic="selection"
                onPress={() => startFast.mutate()}
                style={{
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: instrument.tick,
                  borderRadius: 24,
                  paddingVertical: 16,
                  paddingHorizontal: 16,
                  alignItems: "center",
                }}
              >
                <AppText style={{ color: instrument.mut }}>Start fast</AppText>
              </PressableScale>
            )}
          </Animated.View>

          {/* Meal log stays OUTSIDE the day-total cluster (spec Step 4): each
              slot is a zone-ruled hairline section directly on the ground,
              not another glass panel. */}
          {slots.map((group, gi) => (
            <Animated.View key={group.slot} entering={enter(4 + gi)} style={{ marginBottom: 20 }}>
              <ZoneRule {...formatSlotLabel(group.slot, slotKcal(group))} />
              <View style={{ paddingTop: 10 }}>
                {group.captures.map((c) => {
                  const failed = c.status === "failed";
                  const pendingCapture = c.status === "pending";
                  const statusText = pendingCapture
                    ? online
                      ? "Identifying…"
                      : "Identifying when you're back online"
                    : c.status === "review"
                      ? "Tap to confirm"
                      : "Couldn't identify";
                  // A text capture's own words are a better row title than
                  // "Typed note" — the phrase IS the thing the user logged, and
                  // a queued row is otherwise unidentifiable until it resolves.
                  const name =
                    c.kind === "text" ? (c.phrase ?? "Typed note")
                      : c.kind === "photo" ? "Photo"
                      : "Voice note";
                  return (
                    <MealRow
                      key={c.id}
                      name={name}
                      slot={statusText}
                      kcal={c.kcal}
                      iconName={
                        c.kind === "text" ? "message-circle"
                          : c.kind === "photo" ? "camera"
                          : "mic"
                      }
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
                      accessibilityLabel={`${accessibleMealLabel(r.description, r.portionAssumed)}, ${failed ? "failed to sync" : "waiting to sync"}`}
                      onPress={failed ? () => setFailedRowId(r.id) : undefined}
                      portionAssumed={r.portionAssumed}
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
                          accessibilityLabel={accessibleMealLabel(log.description, log.portion_assumed === true)}
                          portionAssumed={log.portion_assumed === true}
                        />
                      </View>
                    </Swipeable>
                  );
                })}
              </View>
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
                  {`Add ${missingSlot} · ${remaining.toLocaleString()} kcal in reserve`}
                </AppText>
              </PressableScale>
            </Animated.View>
          ) : null}

          {isEmptyDay ? (
            <Animated.View entering={enter(4)}>
              <EmptyState
                variant="instrument"
                icon="book-open"
                title="Nothing logged"
                subtitle="Meals you log on this day appear here."
              />
              <GroupedSection>
                <Row title="Copy from another day" icon={{ name: "repeat", tint: instrument.mut }} onPress={() => setCopyOpen(true)} />
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
    </ScreenEntrance>
  );
}
