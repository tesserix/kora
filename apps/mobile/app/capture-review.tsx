import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Image, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { ResolutionResult, resolveResultView } from "@/components/ResolutionResult";
import { useTheme } from "@/theme";
import {
  list as listCaptures, discard, retry as retryCapture, MAX_RESOLVE_ATTEMPTS, type QueuedCapture,
} from "@/offline/captureQueue";
import { deleteQueuedMedia, queuedMediaUri } from "@/offline/captureMedia";
import { append as appendLog } from "@/offline/queue";
import { drainCaptures } from "@/offline/drainCaptures";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "@/offline/queryKeys";
import type { MealSlot } from "@/lib/mealSlot";
import type { ResolutionSource } from "@/api/types";

// mm:ss, rounding down — a partial second reading "0:12" while playback is
// mid-second is expected, never "0:12.4".
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Typed against ResolutionSource, the same pattern drainCaptures.ts's private
// sourceOf follows (not exported, so this is a deliberate re-derivation, not
// a duplicate import) — never an inline string literal, or a wrong value
// silently buckets into "other" server-side and corrupts the by-source
// metric.
function sourceOf(kind: QueuedCapture["kind"]): ResolutionSource {
  return kind === "photo" ? "ai_photo" : "ai_voice";
}

// captureQueue.ts's recordAttempt is the ONLY path that can drive `attempts`
// up to MAX_RESOLVE_ATTEMPTS while flipping status to "failed" — every other
// failure (CaptureUnidentifiedError, missing media, a permanent 4xx) calls
// markFailed directly and never touches attempts (see drainCaptures.ts's
// catch block). So `attempts >= MAX_RESOLVE_ATTEMPTS` reliably means the AI
// never actually returned a verdict here: DELIVERY itself failed repeatedly
// against a transient network/HTTP error, and `lastError` in that case is the
// RAW `err.message` from that failed call — a diagnostic string, not
// something to present as if the AI had looked at the photo and refused it.
function failureMessage(capture: QueuedCapture): string {
  if (capture.attempts >= MAX_RESOLVE_ATTEMPTS) {
    return "I couldn't reach Kora to identify this — try again.";
  }
  return capture.lastError ?? "Couldn't identify that.";
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

  // Always called, never conditionally — the source is null until a voice
  // capture is loaded, so a photo capture (or the loading/not-found states)
  // simply never gets a real source and the player stays idle.
  const audioSource = capture && capture.kind === "voice" ? queuedMediaUri(capture.storedName) : null;
  const player = useAudioPlayer(audioSource);
  const playerStatus = useAudioPlayerStatus(player);

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

  // A capture the AI genuinely could not identify, or that exhausted its
  // resolve attempts, is kept WITH its media rather than discarded — the
  // user's own record of the meal must survive the AI's failure. Manual
  // logging is seeded with the CAPTURE time, never now, for the same reason
  // handleConfirm seeds logged_at from capture.capturedAt above.
  const handleLogManually = () => {
    if (!capture) return;
    router.push({ pathname: "/log", params: { loggedAt: capture.capturedAt } });
  };

  const handleDiscardFailed = async () => {
    if (!capture) return;
    setBusy(true);
    try {
      await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      router.back();
    } catch {
      setBusy(false);
      Alert.alert("Couldn't discard that", "Please try again.");
    }
  };

  // Rescues exactly the case handleDiscardFailed's media-deleting Discard
  // cannot: attempts exhausted against a transient server/network error, where
  // the AI never actually returned a verdict. Mirrors useQueuedLogs.retryRow —
  // reset to pending, then kick a drain fire-and-forget (the queue is durable,
  // so a failed pass here loses nothing, and awaiting it would let a drain
  // failure surface through this handler's own catch even though the retry
  // itself already succeeded).
  const handleRetryFailed = async () => {
    if (!capture) return;
    setBusy(true);
    try {
      await retryCapture(capture.id);
      invalidate();
      void drainCaptures(qc).catch(() => {});
      router.back();
    } catch {
      setBusy(false);
      Alert.alert("Couldn't retry that", "Please try again.");
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
      ) : capture === null ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <AppText muted style={{ textAlign: "center" }}>
            This capture is no longer waiting on review.
          </AppText>
        </View>
      ) : capture.status === "failed" ? (
        // Decision 3: a permanently failed capture is kept WITH its media and
        // offers manual logging, never discarded on its own — the user's own
        // record of the meal must survive the AI's failure. Voice has no
        // thumbnail, so duration + capture time + playback is the direct
        // analogue of showing the photo (see task-8 brief).
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 18, paddingTop: 8, paddingBottom: insets.bottom + 24, gap: 14 }}
        >
          {capture.kind === "photo" ? (
            <Image
              accessibilityLabel="Captured photo"
              source={{ uri: queuedMediaUri(capture.storedName) }}
              style={{ width: "100%", height: 220, borderRadius: 16, backgroundColor: colors.cardSecondary }}
              resizeMode="cover"
            />
          ) : (
            <View
              style={{
                borderRadius: 16,
                backgroundColor: colors.cardSecondary,
                padding: 18,
                gap: 12,
              }}
            >
              <AppText muted style={{ fontSize: 13 }}>
                Recorded {new Date(capture.capturedAt).toLocaleString()}
              </AppText>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <Button
                  title={playerStatus.playing ? "Pause" : "Play"}
                  variant="secondary"
                  onPress={() => (playerStatus.playing ? player.pause() : player.play())}
                  style={{ minWidth: 100 }}
                />
                <AppText variant="headline">{formatDuration(playerStatus.duration)}</AppText>
              </View>
            </View>
          )}
          <AppText muted>{failureMessage(capture)}</AppText>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button
              title="Retry"
              variant="secondary"
              onPress={handleRetryFailed}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button
              title="Discard"
              variant="secondary"
              onPress={handleDiscardFailed}
              disabled={busy}
              style={{ flex: 1 }}
            />
          </View>
          <Button title="Log it manually" onPress={handleLogManually} disabled={busy} />
        </ScrollView>
      ) : !resolution ? (
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
