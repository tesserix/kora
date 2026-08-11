import { useEffect, useRef, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { AskAgainSheet } from "@/components/meal/AskAgainSheet";
import { MacroRow } from "@/components/meal/MacroRow";
import { SlotSegmented } from "@/components/meal/SlotSegmented";
import { ActionButton } from "@/components/meal/ActionButton";
import { engravedStyle } from "@/components/meal/mealStyles";
import { monoStyle } from "@/components/instrument/typography";
import { provenanceDescriptor, sourceLabel } from "@/components/meal/mealProvenance";
import { PortionField } from "@/components/units/PortionField";
import { haptics, PressableScale } from "@/motion";
import { useEditLog, useDeleteLog, useLog, useRepeatLog, useCreateLog, type EditLogInput } from "@/api/hooks";
import type { FoodItem, FoodLog } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";
import type { ServingUnit } from "@/units/portion";
import { useTheme } from "@/theme";
import { useToast } from "@/components/Toast";

// A fetched log carries the user's entered (amount, unit) pair, but the
// log-fetch endpoint does not currently embed the food's own base unit or
// full serving catalog. When only the entered pair is known, synthesize the
// single serving actually in use — its base_amount is exactly
// quantity_grams / entered_amount, no client-side conversion involved — so
// PortionField can still render the stepper for it. A legacy log (no
// entered pair) has no named serving to offer at all.
function servingUnitsFor(entry: FoodLog | null | undefined): ServingUnit[] {
  if (!entry) return [];
  if (entry.serving_units && entry.serving_units.length > 0) return entry.serving_units;
  if (entry.entered_amount && entry.entered_unit && entry.entered_amount > 0) {
    return [{ name: entry.entered_unit, amount: 1, base_amount: entry.quantity_grams / entry.entered_amount }];
  }
  return [];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The food identity, portion and slot a food-change undo restores. food_item_id
// is optional here only in principle — the server rejects a nil food_item_id
// at log creation, so a fetched/patched log always has one in practice.
type PriorFoodState = {
  food_item_id: string | undefined;
  quantity_grams: number;
  entered_amount: number | null;
  entered_unit: string | null;
  meal_slot: MealSlot;
};

// Builds the portion half of an edit/undo PATCH: the entered pair when the
// portion is serving-based, quantity_grams otherwise. The single place this
// branch is expressed so every mutate call site (save, undo, food-swap,
// undo-food-swap) agrees on it.
function portionPatchFor(
  grams: number,
  enteredAmount: number | null,
  enteredUnit: string | null,
): { quantity_grams: number } | { entered_amount?: number; entered_unit: string } {
  return enteredUnit !== null
    ? { entered_amount: enteredAmount ?? undefined, entered_unit: enteredUnit }
    : { quantity_grams: grams };
}

// What a delete-undo needs to re-create the log exactly as it was.
type RetainedLog = {
  food_item_id: string;
  quantity_grams: number;
  meal_slot: MealSlot;
  logged_at: string;
  source: string;
  input_phrase?: string;
};

// Drives the in-sheet Undo row after a food correction. Rendered inside the
// Sheet itself (not a toast) — a toast is a separate native window on top of
// this screen's Modal and would be invisible/untappable underneath it. `undo`
// is present only when there's an actual prior food to restore (mirrors the
// old toast's `prior.food_item_id` gate); when absent the row still confirms
// the change but offers no action.
type PendingFoodUndo = {
  foodName: string;
  aliasRecorded: boolean;
  phrase?: string;
  undo?: { prior: PriorFoodState };
};

export default function MealDetail() {
  const { instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  const p = useLocalSearchParams<{
    id: string; name: string; mealSlot: string; time: string;
    kcal: string; protein: string; carbs: string; fat: string; grams: string;
  }>();

  const { data: log } = useLog(p.id);
  // Overwritten with the PATCH response right after a successful food change,
  // so the displayed macros come straight from the server — never a local
  // recomputation off the picker's kcal_per_100g.
  const [override, setOverride] = useState<FoodLog | null>(null);
  const effective = override ?? log;

  // Paint instantly from the diary's route params (it already knows the name,
  // kcal and macros), then prefer the fetched/patched log once it's in.
  const name = effective?.description ?? p.name ?? "Meal";
  const baseGrams = effective?.quantity_grams ?? (Number(p.grams) || 0);
  const baseKcal = effective?.kcal ?? (Number(p.kcal) || 0);
  const baseProtein = effective?.protein_g ?? (Number(p.protein) || 0);
  const baseCarbs = effective?.carbs_g ?? (Number(p.carbs) || 0);
  const baseFat = effective?.fat_g ?? (Number(p.fat) || 0);

  // `grams` is the base-unit (server quantity_grams) figure. It is the ONLY
  // thing the macro preview (`scale` below) ever reads, and it only changes
  // when the user edits the exact-mode field in the food's base unit —
  // never as a side effect of a serving-mode edit, which the client cannot
  // convert to grams itself. `enteredAmount`/`enteredUnit` track a serving
  // entry (e.g. "2 sachet") separately; when `enteredUnit` is set that pair
  // — not `grams` — is what gets sent on save, and the SERVER resolves the
  // grams.
  const [grams, setGrams] = useState(baseGrams);
  const [enteredAmount, setEnteredAmount] = useState<number | null>(effective?.entered_amount ?? null);
  const [enteredUnit, setEnteredUnit] = useState<string | null>(effective?.entered_unit ?? null);
  const [slot, setSlot] = useState<MealSlot>((p.mealSlot as MealSlot) ?? "breakfast");
  const [err, setErr] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [askAgainVisible, setAskAgainVisible] = useState(false);
  const [pendingFoodUndo, setPendingFoodUndo] = useState<PendingFoodUndo | null>(null);

  const editLog = useEditLog();
  const deleteLog = useDeleteLog();
  const repeatLog = useRepeatLog();
  const createLog = useCreateLog();
  const toast = useToast();
  const busy = editLog.isPending || deleteLog.isPending || repeatLog.isPending;

  // Display-only preview of the server's own figures — see the comment on
  // `grams` above. It must never be driven by `enteredAmount`/`enteredUnit`:
  // the client cannot compute what those resolve to in grams, only the
  // server can.
  const scale = (base: number) => (baseGrams > 0 ? Math.round(base * grams / baseGrams) : base);
  const kcal = scale(baseKcal);
  // Same fallback pattern as baseGrams: prefer the effective (fetched/patched)
  // log's slot, and only fall back to the route param before it lands. Using
  // p.mealSlot here unconditionally would compare against a baseline that
  // never updates once the server's slot is known.
  const baseSlot = (effective?.meal_slot as MealSlot | undefined) ?? (p.mealSlot as MealSlot);
  const baseEnteredAmount = effective?.entered_amount ?? null;
  const baseEnteredUnit = effective?.entered_unit ?? null;
  // In serving mode (enteredUnit set) the entered pair alone decides
  // dirtiness — `grams` never changed. Out of serving mode, `grams` decides
  // it, UNLESS the baseline itself was a named serving (the user switched
  // OUT of it via the escape hatch), which is a real edit even if `grams`
  // happens to still equal baseGrams.
  const portionDirty =
    enteredUnit !== null
      ? enteredAmount !== baseEnteredAmount || enteredUnit !== baseEnteredUnit
      : grams !== baseGrams || baseEnteredUnit !== null;
  const dirty = portionDirty || slot !== baseSlot;

  const baseUnit: "g" | "ml" = effective?.base_unit === "ml" ? "ml" : "g";
  const servingUnits = servingUnitsFor(effective);
  const portionUnit = enteredUnit ?? baseUnit;
  const portionAmount = enteredUnit !== null ? (enteredAmount ?? grams) : grams;
  const onPortionChange = (amount: number, unit: string) => {
    // An entry IN the food's own base unit is already the base-unit figure,
    // so the macro preview can follow it — no conversion is involved.
    if (unit === baseUnit) setGrams(amount);
    // Only a GRAM entry may drop the entered pair. For a millilitre-based
    // food, "300 ml" entered as bare grams would be stored with a NULL unit
    // and read back as "300 g" forever. units.ToBase resolves ml→ml 1:1
    // server-side, so sending the pair costs nothing and keeps the row honest
    // about what the user meant.
    if (unit === "g") {
      setEnteredAmount(null);
      setEnteredUnit(null);
    } else {
      setEnteredAmount(amount);
      setEnteredUnit(unit);
    }
  };

  // A successful food change replaces the food identity but keeps the same
  // portion/slot, so resync local state to the server's response rather than
  // leaving Save changes armed for no user-made edit.
  useEffect(() => {
    if (!override) return;
    setGrams(override.quantity_grams);
    setSlot(override.meal_slot as MealSlot);
    setEnteredAmount(override.entered_amount ?? null);
    setEnteredUnit(override.entered_unit ?? null);
  }, [override]);

  // grams/slot are first seeded from the diary's route params, which pass a
  // ROUNDED quantity_grams (see app/(tabs)/diary.tsx). Once the fetched log
  // lands, its exact (possibly fractional) quantity_grams becomes baseGrams,
  // so without this resync a rounding artifact alone (e.g. 143 vs 142.5)
  // would make `dirty` true and arm Save changes with no user edit. Guarded
  // to fire only on the FIRST arrival of the fetched log — syncing on every
  // change would clobber an edit the user made while the fetch was in
  // flight.
  const loggedStateSyncedRef = useRef(false);
  useEffect(() => {
    if (!log || loggedStateSyncedRef.current) return;
    loggedStateSyncedRef.current = true;
    // A food-change override already landed before this fetch resolved —
    // its response is more current than the fetch, so don't stomp on it.
    if (override) return;
    setGrams(log.quantity_grams);
    setSlot(log.meal_slot as MealSlot);
    setEnteredAmount(log.entered_amount ?? null);
    setEnteredUnit(log.entered_unit ?? null);
  }, [log]); // eslint-disable-line react-hooks/exhaustive-deps

  // Undoes a food correction: PATCHes the log back to its prior food/portion/
  // slot, retracting the alias THIS correction taught (never any other).
  // Uses mutateAsync + .catch rather than mutate's onError callback so a slow
  // undo still resolves correctly even if something else re-renders this
  // component in between — same reasoning as undoSave/restoreDeletedLog
  // below, though unlike those two this one is triggered from a control that
  // lives INSIDE this same still-mounted sheet, not a toast that can outlive
  // it. Its failure is surfaced via the sheet's own inline error line (`err`)
  // rather than a toast, for the same visibility reason FIX 1 exists at all:
  // a toast renders beneath this still-open native Modal sheet and is
  // invisible/untappable.
  const undoCorrection = (prior: PriorFoodState, aliasRecorded: boolean) => {
    editLog
      .mutateAsync({
        id: p.id,
        food_item_id: prior.food_item_id,
        meal_slot: prior.meal_slot,
        ...portionPatchFor(prior.quantity_grams, prior.entered_amount, prior.entered_unit),
        // retract_correction undoes ONLY the alias THIS correction taught
        // (aliasRecorded true). Sending it unconditionally, or when nothing
        // was taught, would delete an alias a different log may have
        // written for this same phrase.
        ...(aliasRecorded ? { retract_correction: true } : {}),
      })
      .then(({ log: reverted }) => {
        haptics.success();
        setOverride(reverted);
      })
      .catch(() => {
        haptics.error();
        setErr("Couldn't undo. Try again.");
      });
  };

  // Undoes a plain portion/slot save by PATCHing the prior grams and slot
  // back. Never sends retract_correction: a plain save never touches
  // food_item_id, so the server never taught anything to retract — sending
  // the flag here would delete an alias a DIFFERENT log may have taught for
  // the same phrase. Same mutateAsync/.catch reasoning as undoCorrection:
  // onSave already navigates back on success, so the triggering toast can
  // outlive this component.
  const undoSave = (
    priorGrams: number,
    priorSlot: MealSlot,
    priorEnteredAmount: number | null,
    priorEnteredUnit: string | null,
  ) => {
    editLog
      .mutateAsync({
        id: p.id,
        meal_slot: priorSlot,
        ...portionPatchFor(priorGrams, priorEnteredAmount, priorEnteredUnit),
      })
      .then(() => haptics.success())
      .catch(() => {
        haptics.error();
        toast.show({ message: "Couldn't undo. Try again." });
      });
  };

  // Re-creates a deleted log. Same mutateAsync/.catch reasoning as above:
  // onDelete's success handler calls router.back() before this can ever
  // run, so the toast that offers Undo is always shown from an unmounted
  // MealDetail.
  const restoreDeletedLog = (retained: RetainedLog) => {
    createLog
      .mutateAsync({
        food_item_id: retained.food_item_id,
        quantity_grams: retained.quantity_grams,
        meal_slot: retained.meal_slot,
        source: retained.source,
        logged_at: retained.logged_at,
        // Preserve the phrase so a later correction on the restored log can
        // still teach the food index. This mints a NEW log id — a known,
        // accepted limitation.
        input_phrase: retained.input_phrase,
      })
      .catch(() => toast.show({ message: "Couldn't restore. Try again." }));
  };

  const onSelectFood = (item: FoodItem) => {
    // Shared by both the free-index FoodPicker and the AI re-resolve
    // AskAgainSheet — whichever one is open, closing both here keeps this
    // the single PATCH path for "change the logged food" (closing an
    // already-closed sheet is a harmless no-op).
    setPickerVisible(false);
    setAskAgainVisible(false);
    setErr(null);
    // Freeze what's actually on the server right now, from the fetched/patched
    // log — not route params, which go stale the moment an earlier correction
    // in this same session has already changed them. This is what Undo must
    // restore: the ORIGINAL food/portion/slot, not whatever this correction
    // is about to write.
    const prior: PriorFoodState = {
      food_item_id: effective?.food_item_id,
      quantity_grams: baseGrams,
      entered_amount: baseEnteredAmount,
      entered_unit: baseEnteredUnit,
      meal_slot: baseSlot,
    };
    const priorPhrase = effective?.input_phrase;
    // Send the user's current portion/slot alongside the food change so the
    // server applies all three together. Otherwise a PATCH with only
    // food_item_id would echo back the log's ORIGINAL grams/slot, and the
    // effect below would force-resync local state to that echo — silently
    // discarding any unsaved portion or meal-slot edit the user just made.
    // A same-value field is a harmless no-op on the server.
    editLog.mutate(
      { id: p.id, food_item_id: item.id, meal_slot: slot, ...portionPatchFor(grams, enteredAmount, enteredUnit) },
      {
        onSuccess: ({ log: updated, aliasRecorded }) => {
          haptics.success();
          setOverride(updated);
          // Confirmation + Undo render INSIDE the sheet (see PendingFoodUndo)
          // rather than as a toast: onSelectFood deliberately doesn't
          // navigate back so the user can see the recomputed macros, which
          // means a toast would render beneath this still-open native Modal
          // and be invisible/untappable — the bug FIX 1 exists to close.
          // Only offer an actionable Undo when there's a prior food to
          // restore. prior.food_item_id is undefined only in principle (see
          // PriorFoodState) — if it ever were, PATCHing it back would drop
          // the key entirely, the server would see foodChanged === false,
          // and neither the food nor the alias would revert while the row
          // had already promised Kora would remember. Still show the
          // confirmation, just without a broken action.
          setPendingFoodUndo({
            foodName: updated.description,
            aliasRecorded,
            phrase: priorPhrase,
            ...(prior.food_item_id ? { undo: { prior } } : {}),
          });
        },
        onError: () => {
          haptics.error();
          setErr("Couldn't change the food. Try again.");
        },
      },
    );
  };

  const onSave = () => {
    if (!dirty || busy) return;
    setErr(null);
    // Capture before the PATCH resolves and invalidates the log query —
    // baseGrams/baseSlot will reflect the NEW values once that refetch lands.
    const priorGrams = baseGrams;
    const priorSlot = baseSlot;
    const priorEnteredAmount = baseEnteredAmount;
    const priorEnteredUnit = baseEnteredUnit;
    const portionUpdate = portionDirty ? portionPatchFor(grams, enteredAmount, enteredUnit) : {};
    const slotUpdate = slot !== baseSlot ? { meal_slot: slot } : {};
    const patch: EditLogInput = { id: p.id, ...portionUpdate, ...slotUpdate };
    editLog.mutate(patch, {
      onSuccess: () => {
        haptics.success();
        router.back();
        toast.show({
          message: "Saved",
          actionLabel: "Undo",
          onAction: () => undoSave(priorGrams, priorSlot, priorEnteredAmount, priorEnteredUnit),
        });
      },
      onError: () => {
        haptics.error();
        setErr("Couldn't save changes. Try again.");
      },
    });
  };

  const onDelete = () => {
    if (busy) return;
    // Freeze the record that's actually about to be deleted — from the
    // fetched/patched log, not route params — so Undo re-creates exactly
    // what was on the server, even if an earlier correction this session
    // already changed the food, portion or slot.
    const retained = effective
      ? {
          food_item_id: effective.food_item_id,
          quantity_grams: baseGrams,
          meal_slot: baseSlot,
          logged_at: effective.logged_at,
          source: effective.source,
          input_phrase: effective.input_phrase,
        }
      : null;
    Alert.alert("Delete this entry?", "This removes it from your diary.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteLog.mutate(p.id, {
            onSuccess: () => {
              router.back();
              if (retained?.food_item_id) {
                const foodItemId = retained.food_item_id;
                toast.show({
                  message: "Removed",
                  actionLabel: "Undo",
                  onAction: () => restoreDeletedLog({ ...retained, food_item_id: foodItemId }),
                });
              } else {
                toast.show({ message: "Removed" });
              }
            },
            onError: () => setErr("Couldn't delete. Try again."),
          }),
      },
    ]);
  };

  const onRepeat = () => {
    if (busy) return;
    setErr(null);
    repeatLog.mutate(p.id, {
      onSuccess: () => {
        haptics.success();
        router.back();
        Alert.alert("Logged again", "Added to today's diary.");
      },
      onError: () => {
        haptics.error();
        setErr("Couldn't repeat. Try again.");
      },
    });
  };

  // Chip label: source ("Photo") + provenance descriptor ("AI estimate" /
  // "Verified"), joined only when both are known. Neither is on the route
  // params — both come from the fetched/patched log, so the chip is simply
  // absent until that lands (same "unknown until fetched" convention as the
  // Ask-Kora-again link below), rather than a fabricated placeholder value.
  const chipSource = sourceLabel(effective?.source);
  const chipProvenance = provenanceDescriptor(effective?.provenance);
  const provenanceLabel = [chipSource, chipProvenance].filter((v): v is string => Boolean(v)).join(" · ") || null;
  const isAiSource = typeof effective?.source === "string" && effective.source.startsWith("ai_");

  // Macro-row share of THIS meal's calories, via Atwater factors (protein/
  // carbs 4 kcal/g, fat 9 kcal/g) — a figure this screen already has all the
  // inputs for, unlike a "% of today's budget" line (see the hero panel
  // below, which omits that line for the same reason).
  const proteinG = scale(baseProtein);
  const carbsG = scale(baseCarbs);
  const fatG = scale(baseFat);
  const macroKcalTotal = proteinG * 4 + carbsG * 4 + fatG * 9;
  const macroPct = (g: number, kcalPerG: number) =>
    macroKcalTotal > 0 ? Math.round((g * kcalPerG * 100) / macroKcalTotal) : 0;

  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <PressableScale
            haptic="selection"
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: instrument.glass,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: instrument.glassBorder,
            }}
          >
            <AppText style={{ fontSize: 20, fontWeight: "600", color: instrument.ink }}>‹</AppText>
          </PressableScale>
          <View style={{ flex: 1 }}>
            <AppText style={engravedStyle(instrument)}>
              {`${cap(p.mealSlot)} · ${p.time}`}
            </AppText>
            <AppText style={{ fontSize: 22, fontWeight: "700", color: instrument.ink, marginTop: 4 }}>
              {name}
            </AppText>
          </View>
        </View>

        {/* chips row — provenance (accent ◉ only for an AI-resolved source) + mono grams */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 16 }}>
          {provenanceLabel ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 6,
                backgroundColor: instrument.glass,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: instrument.glassBorder,
              }}
            >
              {isAiSource ? <AppText style={{ fontSize: 9, color: instrument.accent }}>◉</AppText> : null}
              <AppText style={engravedStyle(instrument)}>{provenanceLabel}</AppText>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              borderRadius: 999,
              paddingHorizontal: 10,
              paddingVertical: 6,
              backgroundColor: instrument.glass,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: instrument.glassBorder,
            }}
          >
            <AppText style={[{ fontSize: 12, fontWeight: "600", color: instrument.ink }, mono]}>
              {`${Math.round(grams)}${baseUnit}`}
            </AppText>
          </View>
        </View>

        {/* kcal hero. lineHeight is set well above fontSize (72 for a 64px
            numeral) so the numeral's own descenders/ascenders never clip —
            the same fix the GaugeDial center overlay needed. "N% of today's
            budget" is omitted: that figure needs the day's dashboard target,
            which this screen has no fetch for and no mocked test data for —
            per the spec, omit rather than fabricate. */}
        <GlassPanel radius={24} style={{ marginBottom: 16 }}>
          <View style={{ padding: 20 }}>
            <AppText style={[{ fontSize: 64, lineHeight: 72, letterSpacing: -2, color: instrument.ink }, mono]}>
              {kcal.toLocaleString()}
            </AppText>
            <AppText
              style={[
                engravedStyle(instrument),
                { color: instrument.accent, fontSize: 11, letterSpacing: 2, marginTop: 4 },
              ]}
            >
              kcal · this meal
            </AppText>
          </View>
        </GlassPanel>

        {/* macro rows */}
        <GlassPanel radius={22} style={{ marginBottom: 16 }}>
          <View style={{ padding: 16, gap: 14 }}>
            <MacroRow label="Protein" grams={proteinG} pct={macroPct(proteinG, 4)} />
            <MacroRow label="Carbs" grams={carbsG} pct={macroPct(carbsG, 4)} />
            <MacroRow label="Fat" grams={fatG} pct={macroPct(fatG, 9)} />
          </View>
        </GlassPanel>

        {pendingFoodUndo ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 4,
              marginBottom: 16,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderColor: instrument.hairline,
            }}
          >
            <View style={{ flex: 1 }}>
              <AppText style={engravedStyle(instrument)}>Changed</AppText>
              <AppText style={{ fontSize: 14, fontWeight: "600", color: instrument.ink, marginTop: 2 }}>
                Now {pendingFoodUndo.foodName}
              </AppText>
              {pendingFoodUndo.aliasRecorded && pendingFoodUndo.phrase ? (
                <AppText style={{ fontSize: 12, color: instrument.mut, marginTop: 2 }}>
                  Kora will remember &quot;{pendingFoodUndo.phrase}&quot;
                </AppText>
              ) : null}
            </View>
            {pendingFoodUndo.undo ? (
              <PressableScale
                haptic="selection"
                accessibilityRole="button"
                accessibilityLabel="Undo food change"
                hitSlop={8}
                onPress={() => {
                  const { prior } = pendingFoodUndo.undo!;
                  const { aliasRecorded } = pendingFoodUndo;
                  setPendingFoodUndo(null);
                  undoCorrection(prior, aliasRecorded);
                }}
                style={{ minHeight: 44, minWidth: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }}
              >
                {/* Secondary action, demoted from accent: the screen's one
                    accent CTA is "Looks right — keep it" below. */}
                <AppText style={{ color: instrument.ink, fontWeight: "600" }}>Undo</AppText>
              </PressableScale>
            ) : null}
          </View>
        ) : null}

        {/* portion panel */}
        <GlassPanel radius={22} style={{ marginBottom: 16 }}>
          <View style={{ padding: 16, gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <AppText style={engravedStyle(instrument)}>Portion</AppText>
              <AppText style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink }, mono]}>
                {`${Math.round(grams)}${baseUnit}`}
              </AppText>
            </View>
            <PressableScale
              haptic="selection"
              accessibilityRole="button"
              accessibilityLabel="Change food"
              disabled={busy}
              onPress={() => setPickerVisible(true)}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start" }}
            >
              <AppText style={{ fontSize: 14, fontWeight: "600", color: instrument.ink }}>{name}</AppText>
              <Icon name="chevron-right" size={14} color={instrument.mut} />
            </PressableScale>
            {/*
              variant="instrument" restyles PortionField's stepper mode
              (glassBorder pill on an inset well, accent -/+, mono value)
              without touching its default rendering, which app/log.tsx and
              src/components/meals/SavedMealSheet.tsx still rely on.
            */}
            <PortionField
              baseUnit={baseUnit}
              servingUnits={servingUnits}
              amount={portionAmount}
              unit={portionUnit}
              onChange={onPortionChange}
              variant="instrument"
            />
          </View>
        </GlassPanel>

        {/*
          Only a phrase the user actually uttered/typed is something Kora can
          be re-asked about — a manual, memory, photo or barcode log has no
          input_phrase, so there is nothing to escalate. This also gates
          whether AskAgainSheet mounts at all, so useResolveText is never
          invoked (and no AI call risked) for logs that can't use it.
        */}
        {typeof effective?.input_phrase === "string" && effective.input_phrase.length > 0 ? (
          <PressableScale
            haptic="selection"
            accessibilityRole="button"
            accessibilityLabel="Ask Kora again"
            disabled={busy}
            onPress={() => setAskAgainVisible(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingBottom: 12 }}
          >
            {/* Secondary action, demoted from accent: the screen's one
                accent CTA is "Looks right — keep it" below. */}
            <Icon name="sparkles" size={14} color={instrument.ink} />
            <AppText style={{ fontSize: 12, color: instrument.ink, fontWeight: "600" }}>
              Ask Kora again
            </AppText>
          </PressableScale>
        ) : null}

        <AppText style={[engravedStyle(instrument), { marginTop: 8, marginBottom: 8 }]}>Meal</AppText>
        <View style={{ marginBottom: 20 }}>
          <SlotSegmented value={slot} onChange={setSlot} />
        </View>

        {err ? (
          <AppText style={{ fontSize: 13, color: instrument.danger, marginBottom: 12 }}>{err}</AppText>
        ) : null}

        <PressableScale
          haptic="selection"
          accessibilityRole="button"
          accessibilityLabel="Looks right — keep it"
          accessibilityState={{ disabled: !dirty || busy }}
          disabled={!dirty || busy}
          onPress={onSave}
          style={{
            backgroundColor: instrument.accent,
            borderRadius: 22,
            paddingVertical: 15,
            alignItems: "center",
            justifyContent: "center",
            opacity: !dirty || busy ? 0.5 : 1,
            marginBottom: 10,
          }}
        >
          <AppText style={{ color: instrument.accentOn, fontSize: 15, fontWeight: "700" }}>
            Looks right — keep it
          </AppText>
        </PressableScale>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <ActionButton label="Edit" accessibilityLabel="Edit meal" disabled={busy} onPress={() => setPickerVisible(true)} />
          <ActionButton label="Duplicate" accessibilityLabel="Repeat entry" disabled={busy} onPress={onRepeat} />
          <ActionButton label="Delete" accessibilityLabel="Delete entry" disabled={busy} danger onPress={onDelete} />
        </View>
      </View>

      <FoodPicker
        visible={pickerVisible}
        initialQuery={log?.input_phrase ?? name}
        onSelect={onSelectFood}
        onClose={() => setPickerVisible(false)}
      />

      {typeof effective?.input_phrase === "string" && effective.input_phrase.length > 0 ? (
        <AskAgainSheet
          visible={askAgainVisible}
          phrase={effective.input_phrase}
          onSelect={onSelectFood}
          onManualSearch={() => {
            setAskAgainVisible(false);
            setPickerVisible(true);
          }}
          onClose={() => setAskAgainVisible(false)}
        />
      ) : null}
    </Sheet>
  );
}
