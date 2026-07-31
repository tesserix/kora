import { useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { Stepper } from "@/components/Stepper";
import { Segmented } from "@/components/Segmented";
import { Card } from "@/components/Card";
import { Stat } from "@/components/Stat";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { AskAgainSheet } from "@/components/meal/AskAgainSheet";
import { foodVisual } from "@/lib/foodVisual";
import { haptics, PressableScale } from "@/motion";
import { useEditLog, useDeleteLog, useLog, useRepeatLog, useCreateLog, type EditLogInput } from "@/api/hooks";
import type { FoodItem, FoodLog } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";
import { useTheme } from "@/theme";
import { useToast } from "@/components/Toast";

const SLOT_OPTIONS: Array<{ key: MealSlot; label: string }> = [
  { key: "breakfast", label: "Breakfast" },
  { key: "lunch", label: "Lunch" },
  { key: "dinner", label: "Dinner" },
  { key: "snack", label: "Snack" },
];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default function MealDetail() {
  const { colors } = useTheme();
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
  const vis = foodVisual(name, p.mealSlot);
  const baseGrams = effective?.quantity_grams ?? (Number(p.grams) || 0);
  const baseKcal = effective?.kcal ?? (Number(p.kcal) || 0);
  const baseProtein = effective?.protein_g ?? (Number(p.protein) || 0);
  const baseCarbs = effective?.carbs_g ?? (Number(p.carbs) || 0);
  const baseFat = effective?.fat_g ?? (Number(p.fat) || 0);

  const [grams, setGrams] = useState(baseGrams);
  const [slot, setSlot] = useState<MealSlot>((p.mealSlot as MealSlot) ?? "breakfast");
  const [err, setErr] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [askAgainVisible, setAskAgainVisible] = useState(false);

  const editLog = useEditLog();
  const deleteLog = useDeleteLog();
  const repeatLog = useRepeatLog();
  const createLog = useCreateLog();
  const toast = useToast();
  const busy = editLog.isPending || deleteLog.isPending || repeatLog.isPending;

  const scale = (base: number) => (baseGrams > 0 ? Math.round(base * grams / baseGrams) : base);
  const kcal = scale(baseKcal);
  // Same fallback pattern as baseGrams: prefer the effective (fetched/patched)
  // log's slot, and only fall back to the route param before it lands. Using
  // p.mealSlot here unconditionally would compare against a baseline that
  // never updates once the server's slot is known.
  const baseSlot = (effective?.meal_slot as MealSlot | undefined) ?? (p.mealSlot as MealSlot);
  const dirty = grams !== baseGrams || slot !== baseSlot;

  // A successful food change replaces the food identity but keeps the same
  // portion/slot, so resync local state to the server's response rather than
  // leaving Save changes armed for no user-made edit.
  useEffect(() => {
    if (!override) return;
    setGrams(override.quantity_grams);
    setSlot(override.meal_slot as MealSlot);
  }, [override]);

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
    const prior = {
      food_item_id: effective?.food_item_id,
      quantity_grams: baseGrams,
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
      { id: p.id, food_item_id: item.id, quantity_grams: grams, meal_slot: slot },
      {
        onSuccess: ({ log: updated, aliasRecorded }) => {
          haptics.success();
          setOverride(updated);
          toast.show({
            message:
              aliasRecorded && priorPhrase
                ? `Updated · Kora will remember "${priorPhrase}"`
                : "Updated",
            actionLabel: "Undo",
            onAction: () => {
              editLog.mutate(
                {
                  id: p.id,
                  food_item_id: prior.food_item_id,
                  quantity_grams: prior.quantity_grams,
                  meal_slot: prior.meal_slot,
                  // retract_correction undoes ONLY the alias THIS correction
                  // taught (aliasRecorded true). Sending it unconditionally,
                  // or when nothing was taught, would delete an alias a
                  // different log may have written for this same phrase.
                  ...(aliasRecorded ? { retract_correction: true } : {}),
                },
                {
                  onSuccess: ({ log: reverted }) => {
                    haptics.success();
                    setOverride(reverted);
                  },
                  onError: () => {
                    haptics.error();
                    setErr("Couldn't undo. Try again.");
                  },
                },
              );
            },
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
    const patch: EditLogInput = { id: p.id };
    if (grams !== baseGrams) patch.quantity_grams = grams;
    if (slot !== baseSlot) patch.meal_slot = slot;
    editLog.mutate(patch, {
      onSuccess: () => {
        haptics.success();
        router.back();
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
                  onAction: () => {
                    createLog.mutate(
                      {
                        food_item_id: foodItemId,
                        quantity_grams: retained.quantity_grams,
                        meal_slot: retained.meal_slot,
                        source: retained.source,
                        logged_at: retained.logged_at,
                        // Preserve the phrase so a later correction on the
                        // restored log can still teach the food index. This
                        // mints a NEW log id — a known, accepted limitation.
                        input_phrase: retained.input_phrase,
                      },
                      { onError: () => toast.show({ message: "Couldn't restore. Try again." }) },
                    );
                  },
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

  return (
    <Sheet visible onClose={() => router.back()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 14,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.cardSecondary,
            }}
          >
            <Icon name={vis.icon} size={28} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText variant="title2">{name}</AppText>
            <AppText variant="footnote" muted style={{ marginTop: 2 }}>
              {cap(p.mealSlot)} · {p.time}
            </AppText>
          </View>
          <Stat label="Calories" value={String(kcal)} unit="kcal" />
        </View>

        <Card variant="elevated" style={{ flexDirection: "row", marginBottom: 20 }}>
          <View style={{ flex: 1 }}>
            <Stat label="Protein" value={String(scale(baseProtein))} unit="g" valueColor={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Stat label="Carbs" value={String(scale(baseCarbs))} unit="g" valueColor={colors.accentAmber} />
          </View>
          <View style={{ flex: 1 }}>
            <Stat label="Fat" value={String(scale(baseFat))} unit="g" valueColor={colors.accentBlue} />
          </View>
        </Card>

        <Overline>Portion</Overline>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, marginTop: 6 }}>
          <PressableScale
            haptic="selection"
            accessibilityRole="button"
            accessibilityLabel="Change food"
            disabled={busy}
            onPress={() => setPickerVisible(true)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}
          >
            <AppText variant="subheadline" style={{ fontWeight: "600" }}>{name}</AppText>
            <Icon name="chevron-right" size={14} color={colors.tertiaryLabel} />
          </PressableScale>
          <Stepper value={grams} onChange={setGrams} step={10} min={10} />
        </View>

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
            <Icon name="sparkles" size={14} color={colors.accent} />
            <AppText variant="footnote" style={{ color: colors.accent, fontWeight: "600" }}>
              Ask Kora again
            </AppText>
          </PressableScale>
        ) : null}

        <Overline style={{ marginTop: 8 }}>Meal</Overline>
        <View style={{ marginTop: 8, marginBottom: 20 }}>
          <Segmented options={SLOT_OPTIONS} value={slot} onChange={(key) => setSlot(key as MealSlot)} />
        </View>

        {err ? (
          <AppText variant="footnote" style={{ color: colors.destructive, marginBottom: 12 }}>
            {err}
          </AppText>
        ) : null}

        <View style={{ gap: 10 }}>
          <Button title="Save changes" onPress={onSave} disabled={!dirty || busy} />
          <Button
            title="Repeat"
            variant="secondary"
            icon="repeat"
            accessibilityLabel="Repeat entry"
            disabled={busy}
            onPress={onRepeat}
          />
          <Button
            title="Remove"
            variant="destructive"
            icon="trash-2"
            accessibilityLabel="Delete entry"
            disabled={busy}
            onPress={onDelete}
          />
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
