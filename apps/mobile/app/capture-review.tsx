import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { ResolutionResult, resolveResultView } from "@/components/ResolutionResult";
import { useTheme } from "@/theme";
import { list as listCaptures, discard, type QueuedCapture } from "@/offline/captureQueue";
import { deleteQueuedMedia } from "@/offline/captureMedia";
import { append as appendLog } from "@/offline/queue";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "@/offline/queryKeys";
import type { MealSlot } from "@/lib/mealSlot";
import type { ResolutionSource } from "@/api/types";

// Typed against ResolutionSource, the same pattern drainCaptures.ts's private
// sourceOf follows (not exported, so this is a deliberate re-derivation, not
// a duplicate import) — never an inline string literal, or a wrong value
// silently buckets into "other" server-side and corrupts the by-source
// metric.
function sourceOf(kind: QueuedCapture["kind"]): ResolutionSource {
  return kind === "photo" ? "ai_photo" : "ai_voice";
}

// The confirmation surface for a capture that resolved in the background to
// "confirm" or "follow_up" — drainCaptures parked it with status "review" and
// its stored resolution rather than logging it automatically. This is the
// screen diary.tsx's review rows point at.
export default function CaptureReviewScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();

  // undefined = still loading, null = not found (already resolved/discarded
  // elsewhere, or a stale deep link).
  const [capture, setCapture] = useState<QueuedCapture | null | undefined>(undefined);
  const [mealSlot, setMealSlot] = useState<MealSlot>("snack");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listCaptures().then((items) => {
      if (cancelled) return;
      const found = items.find((c) => c.id === id) ?? null;
      setCapture(found);
      if (found?.mealSlot) setMealSlot(found.mealSlot as MealSlot);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const resolution = capture?.resolution;
  const resultView = resolution ? resolveResultView(resolution) : null;
  const candidate = resolution?.candidates?.[0];
  // Only a "card" result names a food to log — a follow-up question has
  // nothing to hand the log queue, so there is nothing honest for Confirm to
  // do there.
  const canConfirm = resultView === "card" && !!candidate?.item;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
  };

  const handleConfirm = async () => {
    if (!capture || !candidate?.item) return;
    setBusy(true);
    try {
      // Append to the log queue, THEN delete the media, THEN drop the capture
      // row — in that order. Deleting the media before the log is safely
      // queued would lose the capture if the append failed.
      await appendLog(
        {
          food_item_id: candidate.item.id,
          quantity_grams: candidate.portion_grams,
          meal_slot: mealSlot,
          // The time the photo/recording was TAKEN, never now — a capture
          // confirmed a day late still counts toward the day it was taken.
          logged_at: capture.capturedAt,
          source: sourceOf(capture.kind),
        },
        capture.id,
        capture.ownerId,
      );
      await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
      router.back();
    } catch {
      setBusy(false);
      Alert.alert("Couldn't confirm that", "Please try again.");
    }
  };

  const handleReject = async () => {
    if (!capture) return;
    setBusy(true);
    try {
      // No logging on reject: delete the media, then drop the row.
      await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      router.back();
    } catch {
      setBusy(false);
      Alert.alert("Couldn't discard that", "Please try again.");
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <ScreenHeader
        overline={capture?.kind === "photo" ? "Photo" : "Voice note"}
        title="Review capture"
        onBack={() => router.back()}
      />
      {capture === undefined ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.tertiaryLabel} />
        </View>
      ) : capture === null || !resolution ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <AppText muted style={{ textAlign: "center" }}>
            This capture is no longer waiting on review.
          </AppText>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          // Mirrors capture.tsx's own contentContainerStyle: ResolutionResult
          // returns a Fragment, and its children rely on the SCROLL
          // CONTAINER'S gap for spacing, not their own margins.
          contentContainerStyle={{ padding: 18, paddingTop: 8, paddingBottom: insets.bottom + 24, gap: 14 }}
        >
          <ResolutionResult
            resolution={resolution}
            mealSlot={mealSlot}
            onChangeMealSlot={setMealSlot}
            onAdd={handleConfirm}
            adding={busy}
            onSearchManually={() => router.push("/log")}
          />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button
              title="Not right"
              variant="secondary"
              onPress={handleReject}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button
              title="Confirm"
              onPress={handleConfirm}
              disabled={busy || !canConfirm}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      )}
    </View>
  );
}
