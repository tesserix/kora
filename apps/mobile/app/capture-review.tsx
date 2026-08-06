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
import { list as listCaptures, discard, retry as retryCapture, type QueuedCapture } from "@/offline/captureQueue";
import { deleteQueuedMedia, queuedMediaUri } from "@/offline/captureMedia";
import { append as appendLog, newLogId } from "@/offline/queue";
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

// Switches on the EXPLICIT `failureKind` drainCaptures.ts tags every failed
// capture with — never on `attempts`. `attempts` cannot distinguish these:
// a permanent 4xx (a delivery failure — the server refused the request, so
// the AI never rendered a verdict) calls markFailed directly and leaves
// attempts untouched, exactly like an identification failure does. Only the
// site that actually catches the error (drainCaptures.ts) knows which of the
// three happened, so that is where the tag is set.
//
// The `undefined` case (a row persisted before this field existed — this
// feature has never shipped, so the only such rows are from an earlier
// commit of this same branch on a developer's simulator) is deliberately its
// OWN branch, not folded into "identification": we do not know why an
// untagged row failed, so its `lastError` might be a raw HTTP/network string
// from before failureKind existed. Rendering it would be exactly the leak
// this field was added to close, reached by a different route. Fixed, safe
// copy only — never `lastError` — for an unknown cause.
function failureMessage(capture: QueuedCapture): string {
  switch (capture.failureKind) {
    case "delivery":
      // lastError here is the RAW err.message from a failed network/HTTP
      // call (drainCaptures.ts's catch block) — a diagnostic string, never
      // something to present as if the AI had looked at the photo and
      // refused it.
      return "I couldn't reach Kora to identify this — try again.";
    case "missing-media":
      return capture.lastError ?? "The photo or recording is no longer on this device.";
    case "identification":
      // lastError here is CaptureUnidentifiedError's own friendly message —
      // safe to show, and safe to fall back on.
      return capture.lastError ?? "Couldn't identify that.";
    default:
      // Untagged: cause unknown, so lastError is untrusted. Fixed copy only.
      return "Couldn't identify that.";
  }
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
        // A FRESH log id, never `capture.id`: the capture queue's key is
        // `cap_<millis>_<rand>` and the server binds this field as
        // `ID *uuid.UUID`, so reusing it 400s — and the log queue treats a
        // 400 as terminal, after the media below is already gone. See
        // newLogId in src/offline/queue.ts.
        newLogId(),
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

  // "Search manually" from a REVIEWED capture (tier confirm/follow_up).
  //
  // Two bugs met here. First, this handler used to push "/log" bare, so
  // log.tsx fell back to `new Date()` and the entry landed on the day the
  // user got round to it rather than the day the food was eaten — the one
  // log-creating path that broke decision 2 (capture time, always).
  //
  // Second, and worse for a `follow_up`: Confirm is disabled when the result
  // is a question rather than a card, so before this change the ONLY exit
  // from such a row was Discard. A user who took this route and logged the
  // food kept a "Tap to confirm" review row sitting over the meal they had
  // just written, forever.
  //
  // So this treats the press as what it is — the user rejecting the AI's
  // reading and taking the meal over themselves — and resolves the capture on
  // exactly the terms "Not right" already does: media deleted, row dropped.
  // The AI has already rendered its verdict on this media, so unlike the
  // FAILED path (handleLogManually below, decision 3) there is nothing left
  // for the file to be retried against.
  const handleSearchManually = async () => {
    if (!capture) return;
    setBusy(true);
    try {
      await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      router.push({ pathname: "/log", params: { loggedAt: capture.capturedAt } });
    } catch {
      setBusy(false);
      Alert.alert("Couldn't open manual logging", "Please try again.");
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
            onSearchManually={handleSearchManually}
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
