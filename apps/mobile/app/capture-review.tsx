import { useEffect, useMemo, useState } from "react";
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
import { useToast } from "@/components/Toast";
import { safeBack } from "@/lib/safeBack";
import { useTheme } from "@/theme";
import { currentUserId } from "@/lib/api";
import { list as listCaptures, discard, restore, retry as retryCapture, hasMedia, type QueuedCapture } from "@/offline/captureQueue";
import { deleteQueuedMedia, queuedMediaUri } from "@/offline/captureMedia";
import { append as appendLog, newLogId } from "@/offline/queue";
import { drainCaptures } from "@/offline/drainCaptures";
import { QUEUED_CAPTURES_KEY, QUEUED_LOGS_KEY } from "@/offline/queryKeys";
import { isLoggable } from "@/lib/candidateTier";
import { runRetryLedger } from "@/lib/retryLedger";
import { FoodPicker } from "@/components/meal/FoodPicker";
import { initialPortionFor } from "@/lib/promotedPortion";
import type { MealSlot } from "@/lib/mealSlot";
import type { FoodItem, ResolutionSource } from "@/api/types";

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
  if (kind === "photo") return "ai_photo";
  if (kind === "text") return "ai_text";
  return "ai_voice";
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

// Every exit on this screen goes through safeBack, never router.back(): this
// is the one screen that documents deep entry (`/capture-review?id=…`, see the
// owner-gated loader below), and on a deep-linked mount the stack is empty, so
// GO_BACK dispatches into nothing and every exit is dead. The diary is the
// honest anchor — it is where this screen's rows live and the only place that
// pushes it.
const EXIT_TO = "/(tabs)/diary" as const;

// The confirmation surface for a capture that resolved in the background to
// "confirm" or "follow_up" — drainCaptures parked it with status "review" and
// its stored resolution rather than logging it automatically. This is the
// screen diary.tsx's review rows point at.
export default function CaptureReviewScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();

  // undefined = still loading, null = not found (already resolved/discarded
  // elsewhere, or a stale deep link).
  const [capture, setCapture] = useState<QueuedCapture | null | undefined>(undefined);
  const [mealSlot, setMealSlot] = useState<MealSlot>("snack");
  const [busy, setBusy] = useState(false);
  // Which candidates (by candidateKey — the shared retry ledger's own key,
  // the same one capture.tsx's handleAddToDiary records under) have already
  // been queued, across every Confirm press for this capture. A retry after a
  // partial failure must not re-submit one of these: appendLog mints a FRESH
  // log id every time it's called, so resubmitting an already-queued candidate
  // would not update the existing log, it would create a second one under a
  // different id, and the server has no way to recognise the duplicate.
  const [loggedCandidateKeys, setLoggedCandidateKeys] = useState<Set<string>>(new Set());
  // Per-row exclusion, same as capture.tsx (kora#183). This screen replays the
  // very same DetectedCard, so it had the very same defect: a checkbox-looking
  // glyph and no way to drop a row. Indices are stable here — the resolution
  // is restored with the capture and never replaced.
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(() => new Set());
  // In-place correction, the same shape capture.tsx holds (kora#198). Change
  // used to push to /log, which never read the candidateIndex it was given and
  // so simply LOGGED the food — leaving the queued capture untouched and, with
  // kora#111's surviving row, letting Confirm log the rejected food as well.
  //
  // Index-keyed like `excluded` above, and safe for the same reason: this
  // screen's resolution is restored with the capture and never replaced.
  const [promoted, setPromoted] = useState<Record<number, FoodItem>>({});
  const [promotedPortion, setPromotedPortion] = useState<
    Record<number, { grams: number; assumed: boolean }>
  >({});
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);

  function toggleExcluded(index: number) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // Always called, never conditionally — the source is null until a voice
  // capture is loaded, so a photo capture (or the loading/not-found states)
  // simply never gets a real source and the player stays idle.
  const audioSource = capture?.kind === "voice" ? queuedMediaUri(capture.storedName) : null;
  const player = useAudioPlayer(audioSource);
  const playerStatus = useAudioPlayerStatus(player);

  // The same accessor drainCaptures and useQueuedCaptures read, so this screen
  // shows exactly the rows those two agree belong to the signed-in user. The
  // capture queue is one device-wide list; accounts are not.
  const ownerId = currentUserId();

  useEffect(() => {
    let cancelled = false;
    listCaptures().then((items) => {
      if (cancelled) return;
      // Gated on ownerId as well as id — this was the ONLY reader on the
      // branch that was not (cf. useQueuedCaptures.ts and drainCaptures.ts).
      // Without it a deep link `/capture-review?id=…` rendered another
      // account's photo, played their voice note, and let Discard delete it.
      // A row that exists but belongs to someone else is `null` here, i.e.
      // indistinguishable from one that does not exist — a match that leaked
      // "wrong owner" as its own state would confirm the id is real.
      const found = items.find((c) => c.id === id && !!ownerId && c.ownerId === ownerId) ?? null;
      setCapture(found);
      if (found?.mealSlot) setMealSlot(found.mealSlot as MealSlot);
    });
    return () => {
      cancelled = true;
    };
  }, [id, ownerId]);

  const stored = capture?.resolution;
  // The capture as the user has amended it. Identical treatment to
  // capture.tsx's effectiveResolution, including the kcal rules: a hand-picked
  // row carries NO kcal (the client never derives nutrition — the server
  // recomputes on log), and takes the replacement food's OWN portion rather
  // than inheriting the replaced food's (kora#190).
  const resolution = useMemo(() => {
    if (!stored || Object.keys(promoted).length === 0) return stored;
    return {
      ...stored,
      candidates: stored.candidates.map((candidate, i) => {
        const item = promoted[i];
        if (!item) return candidate;
        const portion = promotedPortion[i] ?? initialPortionFor(item);
        return {
          ...candidate,
          item,
          kcal: 0,
          tier: "confirm" as const,
          kcal_unknown: true,
          portion_grams: portion.grams,
          portion_assumed: portion.assumed,
        };
      }),
    };
  }, [stored, promoted, promotedPortion]);
  const resultView = resolution ? resolveResultView(resolution) : null;
  const loggable = (resolution?.candidates ?? []).filter((c, i) => isLoggable(c) && !excluded.has(i));
  // Only a "card" result names food to log — a follow-up question has nothing
  // to hand the log queue, so there is nothing honest for Confirm to do
  // there.
  const canConfirm = resultView === "card" && loggable.length > 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QUEUED_CAPTURES_KEY] });
  };

  const handleConfirm = async () => {
    if (!capture || loggable.length === 0) return;
    setBusy(true);
    try {
      // Queue EVERY item, not just the first. The card above can say
      // "Add 2 items to diary"; logging one and deleting the capture row
      // destroyed the rest with no trace.
      //
      // Which items that is — keying off the FULL candidates array, the
      // exclusions, skipping what an earlier attempt already queued, the
      // allSettled and the union write — is runRetryLedger's, shared verbatim
      // with capture.tsx's Add to diary (kora#144). This screen supplies only
      // the backend: the offline log queue rather than the createLog mutation.
      const attempt = await runRetryLedger({
        candidates: resolution?.candidates ?? [],
        excluded,
        logged: loggedCandidateKeys,
        markLogged: setLoggedCandidateKeys,
        logCandidate: (c, index) =>
          appendLog(
            {
              food_item_id: c.item.id,
              quantity_grams: c.portion_grams,
              meal_slot: mealSlot,
              // The time the photo/recording was TAKEN, never now — a capture
              // confirmed a day late still counts toward the day it was taken.
              logged_at: capture.capturedAt,
              source: sourceOf(capture.kind),
              ...(resolution?.resolution_id ? { resolution_id: resolution.resolution_id, resolution_index: index } : {}),
            },
            // A FRESH log id per item, never `capture.id`: the capture queue's
            // key is `cap_<millis>_<rand>` and the server binds this field as
            // `ID *uuid.UUID`, so reusing it 400s — and the log queue treats a
            // 400 as terminal, after the media below is already gone.
            newLogId(),
            capture.ownerId,
          ),
      });

      const failed = attempt.failed.length;
      if (failed > 0) {
        // The capture row and its media are the only copy of an item that did
        // not queue. Keep both so the user can retry rather than losing it.
        setBusy(false);
        Alert.alert(
          "Some items didn't save",
          `${failed} of ${attempt.pending.length} couldn't be queued. Your capture is still here — try again.`,
        );
        return;
      }

      // Nothing failed this attempt, which means every loggable candidate is
      // now in loggedCandidateKeys — either this attempt just finished the
      // last of them, or a retry found `pending` empty because an earlier
      // attempt already logged everything. Either way it is safe to delete:
      // a retry that finds nothing left to queue must still finish rather
      // than leave the user stranded on a screen whose items are all logged.
      if (hasMedia(capture)) await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      qc.invalidateQueries({ queryKey: [QUEUED_LOGS_KEY] });
      safeBack(EXIT_TO);
    } catch {
      setBusy(false);
      Alert.alert("Couldn't confirm that", "Please try again.");
    }
  };

  // "Search manually" from a REVIEWED capture.
  //
  // It used to push "/log" bare, so log.tsx fell back to `new Date()` and the
  // entry landed on the day the user got round to it rather than the day the
  // food was eaten — the one log-creating path that broke decision 2 (capture
  // time, always). Seeding `loggedAt` is the whole of the fix.
  //
  // It deliberately does NOT delete the media or drop the row, for three
  // reasons:
  //
  //  1. Neither branch that renders this link is a verdict. ResolutionResult
  //     shows it under a follow-up QUESTION and under "I couldn't identify
  //     that" — the AI asking something back, or declining to answer. Decision
  //     3's "the user's own record of the meal must survive the AI's failure"
  //     applies here exactly as it does to a failed capture.
  //  2. handleLogManually below does the same user-facing thing — push /log
  //     with the same loggedAt — and keeps both media and row. Two handlers
  //     with one meaning must not disagree about whether the capture survives.
  //  3. This is a plain link with no confirmation, and a deletion here lands
  //     BEFORE navigation. A misdirected tap, a back-out of /log, or the app
  //     being killed on that screen would destroy the photo with no log
  //     written — precisely the outcome this queue exists to prevent.
  //
  // Discard remains the explicit, deliberate exit for removing a capture.
  const handleSearchManually = () => {
    if (!capture) return;
    router.push({ pathname: "/log", params: { loggedAt: capture.capturedAt } });
  };

  // "Tap to change" on a single uncertain row (ResolutionResult ->
  // DetectedCard's CandidateRow). This screen used to pass no
  // onResolveUncertain at all, so the row rendered but did nothing — dead
  // affordance where capture.tsx's live-capture path already works.
  //
  // Routes to the same manual-search screen and seeds the same capture-time
  // loggedAt as handleSearchManually above, for the identical reason: no
  // branch that opens /log from a reviewed capture may fall back to `new
  // Date()`. The row's own index rides along as `candidateIndex` so a future
  // consumer can target the right row for replacement; wiring /log to
  // actually consume it is out of this task's scope.
  const handleResolveUncertain = (index: number) => {
    if (!capture) return;
    setPickerIndex(index);
  };

  // "Discard capture" — named for its consequence. It used to read "Not
  // right", which says "this identification is wrong, try again" and is
  // therefore exactly what a user wanting to RE-identify would tap; it then
  // deleted the media and dropped the row, destroying the only copy of the
  // photo or recording with no confirmation and no way back.
  //
  // A confirm Alert would be the over-correction — this is one tap among three
  // on a review screen, not the deletion of something already logged — so the
  // single tap stays and an Undo toast carries the reversibility, the same
  // shape meal.tsx's save and delete already use.
  //
  // The media is deliberately NOT deleted here, which is what makes the Undo
  // real: `restore` can put the row back, but nothing can put the file back.
  // The file is left for sweepOrphans, which runs once per launch
  // (drainTriggers.ts) — so it comfortably outlives the toast, and is reclaimed
  // on the next launch if the user let the discard stand.
  const handleDiscard = async () => {
    if (!capture) return;
    const discarded = capture;
    setBusy(true);
    try {
      await discard(discarded.id);
      invalidate();
      safeBack(EXIT_TO);
      toast.show({
        message: "Capture discarded",
        actionLabel: "Undo",
        onAction: () => {
          // Restores the row WHOLE — status "review" and its stored
          // resolution, not a fresh pending capture (see captureQueue.restore).
          restore(discarded)
            .then(invalidate)
            .catch(() => Alert.alert("Couldn't undo that", "Please try again."));
        },
      });
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
      if (hasMedia(capture)) await deleteQueuedMedia(capture.storedName);
      await discard(capture.id);
      invalidate();
      safeBack(EXIT_TO);
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
      safeBack(EXIT_TO);
    } catch {
      setBusy(false);
      Alert.alert("Couldn't retry that", "Please try again.");
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      {/* insets.top, or the header renders UNDER the status bar — the clock and
          battery sit on top of the title and the overline collides with it
          (kora#192, seen on device).

          ScreenHeader deliberately carries no top inset of its own; every other
          screen that uses it applies one (settings.tsx:72, friends.tsx:73,
          log.tsx:334 all use `insets.top + 8`). This screen used `insets` for
          paddingBottom only and was the sole deviation.

          It survived every simulator pass because the screen is reachable ONLY
          by draining an offline capture — queue in airplane mode, reconnect,
          tap the diary row. No online path renders it. Same class of gap as
          kora#139. */}
      <View style={{ paddingTop: insets.top + 8 }}>
        <ScreenHeader
          overline={
            capture?.kind === "text" ? "Typed"
              : capture?.kind === "photo" ? "Photo"
              : "Voice note"
          }
          title="Review capture"
          onBack={() => safeBack(EXIT_TO)}
        />
      </View>
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
          {capture.kind === "text" ? (
            // Styled AFTER UserBubble, not reusing it: that component is built
            // for the capture thread — right-aligned with a FadeInDown
            // entrance — and this screen is not a thread and has no sender to
            // align against. Same surface treatment, static.
            <View
              style={{
                borderRadius: 16,
                backgroundColor: colors.cardSecondary,
                padding: 18,
                gap: 8,
              }}
            >
              <AppText muted style={{ fontSize: 13 }}>
                Typed {new Date(capture.capturedAt).toLocaleString()}
              </AppText>
              <AppText variant="headline">{capture.phrase}</AppText>
            </View>
          ) : capture.kind === "photo" ? (
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
            excluded={excluded}
            onToggleExclude={toggleExcluded}
            onChangePortion={(index, grams) =>
              setPromotedPortion((prev) => ({ ...prev, [index]: { grams, assumed: false } }))
            }
            // This screen supplies its own Confirm/Discard pair below, so the
            // card must not render a second, identical accent CTA (kora#193).
            hideAddButton
            onResolveUncertain={handleResolveUncertain}
          />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button
              title="Discard capture"
              variant="secondary"
              onPress={handleDiscard}
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
          {/* The third, non-destructive route: "this isn't right" now has an
              answer that keeps the capture. Card view only — the follow-up and
              unidentified views already render ResolutionResult's own
              SearchManuallyLink, and two identical affordances would be worse
              than none. */}
          {resultView === "card" ? (
            <Button
              title="Search manually"
              variant="secondary"
              onPress={handleSearchManually}
              disabled={busy}
            />
          ) : null}
        </ScrollView>
      )}

      {/* Seeded from the CORRECTED row, not the stored one — a second visit to
          an already-changed row must not re-offer the food the user rejected
          (the kora#189 lesson, applied here from the start). */}
      <FoodPicker
        visible={pickerIndex !== null}
        initialQuery={
          pickerIndex !== null ? (resolution?.candidates[pickerIndex]?.item.name ?? "") : ""
        }
        onSelect={(item) => {
          if (pickerIndex !== null) {
            setPromoted((prev) => ({ ...prev, [pickerIndex]: item }));
            setPromotedPortion((prev) => ({ ...prev, [pickerIndex]: initialPortionFor(item) }));
          }
          setPickerIndex(null);
        }}
        onClose={() => setPickerIndex(null)}
        forceDark
      />
    </View>
  );
}
