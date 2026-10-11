import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { AppText } from "@/components/Text";
import { useToast } from "@/components/Toast";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { useAddWeight, useReadBodyComposition } from "@/api/hooks";
import type { BodyCompositionReadResult, WeightSource } from "@/api/types";
import { isOnline, useIsOnline } from "@/offline/connectivity";
import { detectedInstrumentSource, MANUAL_SOURCES, orderSourcesDetectedFirst } from "@/lib/bodyCompositionFields";
import { droppedFieldsNotice, pickScaleScreenshot, readFailureMessage } from "@/lib/bodyCompositionScan";
import { compositionValuesFromReading, type AddWeightPayload, type CompositionValues } from "@/lib/bodyCompositionForm";
import { requestWeightPermission } from "@/health/weightPermission";
import { useTheme } from "@/theme";
import { BodyCompositionForm, type BodyCompositionFormHandle } from "./BodyCompositionForm";

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * The WEIGHT to seed Manual mode with — the last logged weigh-in, or the
   * profile's own figure before there is one, exactly like the pre-#314
   * `WeightLogSheet` this sheet replaces. `<= 0` means nothing to seed
   * (matches that sheet's own `seedText` guard).
   */
  initialKg?: number;
  /** Profile height, threaded through to BodyCompositionForm for BMI. */
  heightCm?: number;
}

type Mode = "manual" | "screenshot";
type ScreenshotStage = "capture" | "form";

const MODE_OPTIONS = [
  { key: "manual", label: "Manual" },
  { key: "screenshot", label: "Screenshot" },
];

/**
 * The ONE weight-logging entry point Trends offers (kora#314 PR C).
 *
 * Replaces three separate sheets — `WeightLogSheet`, `BodyCompositionSheet`
 * and `BodyCompositionScanSheet` — that used to sit behind three separate
 * buttons on the Trends panel. A single "Log weight" affordance now opens
 * this, and this owns which of two MODES is active:
 *
 * - Manual: BodyCompositionForm in its collapsed, weight-only shape — see
 *   that component's own doc comment for why collapsing is safe (nothing in
 *   the hidden section is reset, only hidden) and BodyCompositionSheet's
 *   original comment (preserved there in spirit) for why this matters: most
 *   days are weight and nothing else, and putting nine optional fields in
 *   front of that would be a regression for the common case.
 * - Screenshot: the old BodyCompositionScanSheet's capture step, feeding the
 *   SAME form component pre-filled and already expanded — a screenshot
 *   arrives WITH composition values, so there is something to show
 *   immediately, unlike a bare "Log weight" tap.
 *
 * Both modes end at the same confirm-and-write step (BodyCompositionForm +
 * useAddWeight); nothing is written until that Save is pressed. Switching
 * modes remounts whichever form/capture-step is not currently shown (via the
 * `mode === ...` conditional below), so a half-typed manual draft does not
 * leak into a screenshot confirm or vice versa — the same "fresh form per
 * mount" guarantee BodyCompositionForm's own doc comment describes for a
 * reopened sheet.
 */
export function LogWeightSheet({ visible, onClose, initialKg = 0, heightCm }: Props) {
  const { instrument, spacing } = useTheme();
  const toast = useToast();
  const online = useIsOnline();
  const readBodyComposition = useReadBodyComposition();
  const addWeight = useAddWeight();

  const [mode, setMode] = useState<Mode>("manual");
  const [manualError, setManualError] = useState<string | null>(null);
  // One ref, safe to share across Manual and Screenshot: `mode === ...`
  // below mounts at most one BodyCompositionForm at a time (the other branch
  // renders nothing), so there is never a moment where two forms compete to
  // own it.
  const formRef = useRef<BodyCompositionFormHandle>(null);

  const [screenshotStage, setScreenshotStage] = useState<ScreenshotStage>("capture");
  const [notice, setNotice] = useState<string | null>(null);
  const [screenshotInitialValues, setScreenshotInitialValues] = useState<CompositionValues | undefined>(undefined);
  const [screenshotInitialReadingDate, setScreenshotInitialReadingDate] = useState<string | undefined>(undefined);
  // The vision pass' guess at which instrument produced the screenshot, or
  // null before a read completes / when a read never identified one — see
  // detectedInstrumentSource's own comment on why null is treated the same
  // as "scale_screenshot" rather than as an error.
  const [detectedSource, setDetectedSource] = useState<WeightSource | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  // Reseed on every open, same as the sheets this replaces — every one of
  // them stays mounted between opens (only Sheet's `visible` gate hides it),
  // so a stale mode/read from a previous visit must never leak into the next.
  useEffect(() => {
    if (!visible) return;
    setMode("manual");
    setManualError(null);
    setScreenshotStage("capture");
    setNotice(null);
    setScreenshotInitialValues(undefined);
    setScreenshotInitialReadingDate(undefined);
    setDetectedSource(null);
    setScreenshotError(null);
  }, [visible]);

  // #375: the ONE place Kora asks for HealthKit weight access.
  //
  // The launch-time sync (src/health/useHealthSync.ts) deliberately never
  // prompts -- a Health sheet thrown at a user on their first launch, before
  // anything has explained why, invites a "Don't Allow" that is effectively
  // permanent (a read denial is reversible only in Settings, and iOS will
  // not tell us it happened). Here the ask explains itself: the user has
  // just tapped "Log weight", so "Kora would like to read your weight" is
  // the obvious next sentence, and granting it means the scale readings
  // they already have show up without re-typing.
  //
  // Fire-and-forget, and failures are swallowed on purpose. iOS shows this
  // sheet at most once per read type per install, so on every later open
  // this resolves with no UI at all; and on a build without HealthKit linked
  // the lazy require inside throws. Neither is the user's problem -- manual
  // logging, which is what this sheet is actually for, works identically
  // either way, so there is nothing worth interrupting them with.
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS !== "ios") return;
    void requestWeightPermission().catch(() => {});
  }, [visible]);

  function openManualFallback(explanation: string) {
    setScreenshotInitialValues(undefined);
    setScreenshotInitialReadingDate(undefined);
    setDetectedSource(null);
    setNotice(explanation);
    setScreenshotStage("form");
  }

  function applyReading(result: BodyCompositionReadResult) {
    // Unreadable never actually reaches here as a 200 (the handler maps it
    // to a 422, caught by onError below) — this branch exists only so a
    // future change to that contract fails safely into the manual fallback
    // rather than opening a form seeded from a reading that turned out to
    // be entirely empty.
    if (result.unreadable) {
      openManualFallback("Couldn't read anything from that screenshot. Enter your numbers below instead.");
      return;
    }
    setScreenshotInitialValues(compositionValuesFromReading(result.reading));
    setScreenshotInitialReadingDate(result.reading.reading_date);
    setDetectedSource(detectedInstrumentSource(result.reading));
    setNotice(droppedFieldsNotice(result.dropped_fields));
    setScreenshotStage("form");
  }

  async function pickAndRead() {
    // ONLINE-ONLY, DELIBERATELY — do NOT "fix" this by adding offline
    // queueing. kora#314's binding decision is that the uploaded screenshot
    // is NEVER stored, not on the server and not on the device: it is read
    // in memory and discarded (api/internal/bodyread/service.go). The
    // offline queue works by persisting media to disk for a later replay
    // (MediaCapture.storedName in src/offline/captureQueue.ts) — queueing
    // this upload would mean writing the very screenshot the whole feature
    // exists to never write. So this is the one capture path in the app
    // that does not queue, and it must say so up front rather than let a
    // background upload silently fail later. `useIsOnline()` above already
    // keeps the button itself honest about this; this is a same-instant
    // re-check for the gap between a stale render and the actual tap.
    if (!isOnline()) {
      openManualFallback("You're offline, and reading a screenshot needs a connection. Enter your numbers below instead.");
      return;
    }
    const outcome = await pickScaleScreenshot();
    if (outcome.status === "canceled") return;
    if (outcome.status === "denied") {
      toast.show({ message: "I need photo access to read a scale screenshot. Turn it on in Settings." });
      return;
    }
    if (outcome.status === "failed") {
      toast.show({ message: "Something went wrong opening your photos — try again." });
      return;
    }
    readBodyComposition.mutate(outcome.file, {
      onSuccess: applyReading,
      onError: (error) => openManualFallback(readFailureMessage(error)),
    });
  }

  function onManualSubmit(payload: AddWeightPayload) {
    setManualError(null);
    addWeight.mutate(payload, {
      onSuccess: () => onClose(),
      onError: () => setManualError("Couldn't save. Try again."),
    });
  }

  function onScreenshotSubmit(payload: AddWeightPayload) {
    setScreenshotError(null);
    addWeight.mutate(payload, {
      onSuccess: () => onClose(),
      onError: () => setScreenshotError("Couldn't save. Try again."),
    });
  }

  // The detected instrument goes FIRST so BodyCompositionForm's own
  // `sources[0]` default pre-selects it, while every entry still renders as
  // the existing multi-entry SegmentedGlass control (kora#314 PR C) — a
  // misdetection stays correctable rather than a stated, unchangeable fact.
  const screenshotSources = orderSourcesDetectedFirst(detectedSource ?? "scale_screenshot");

  // A BodyCompositionForm is mounted in exactly two of the three visible
  // states: Manual mode, and Screenshot mode once a read (or its manual
  // fallback) has produced a form to confirm. The capture step has no form
  // and nothing to save yet, so it gets no footer — Sheet already renders
  // with none exactly as it did before this prop existed.
  const formMounted = mode === "manual" || screenshotStage === "form";
  const footer = formMounted ? (
    <Button
      testID="log-weight-save"
      title="Save"
      onPress={() => formRef.current?.submit()}
      disabled={addWeight.isPending}
    />
  ) : undefined;

  return (
    <Sheet visible={visible} onClose={onClose} footer={footer}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.md }}>
        <Overline>Log weight</Overline>
        <SegmentedGlass
          testID="log-weight-mode"
          options={MODE_OPTIONS}
          value={mode}
          onChange={(key) => setMode(key as Mode)}
        />

        {mode === "manual" ? (
          <BodyCompositionForm
            // Seeded once per mount, and remounted (fresh) whenever the mode
            // switches back to "manual" — see this component's own doc
            // comment on why that's the right trade for a mode toggle.
            key="manual"
            ref={formRef}
            initialValues={initialKg > 0 ? { weight_kg: initialKg } : undefined}
            sources={MANUAL_SOURCES}
            heightCm={heightCm}
            expandable
            initiallyExpanded={false}
            submitting={addWeight.isPending}
            error={manualError}
            hideSubmitButton
            onSubmit={onManualSubmit}
          />
        ) : screenshotStage === "capture" ? (
          <>
            {online ? (
              <>
                <AppText muted style={{ fontSize: 13 }}>
                  Choose a screenshot of your smart scale&apos;s result screen. Kora reads it, you confirm the
                  numbers, and the screenshot itself is never saved.
                </AppText>
                {readBodyComposition.isPending ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 14 }}>
                    <ActivityIndicator color={instrument.mut} />
                    <AppText muted>Reading your screenshot…</AppText>
                  </View>
                ) : (
                  <Button title="Choose screenshot" onPress={() => void pickAndRead()} />
                )}
              </>
            ) : (
              <>
                <AppText muted style={{ fontSize: 13 }}>
                  Reading a screenshot needs a connection, and you&apos;re offline right now. Enter your numbers
                  manually instead.
                </AppText>
                <Button
                  title="Enter manually"
                  onPress={() =>
                    openManualFallback(
                      "You're offline, and reading a screenshot needs a connection. Enter your numbers below instead.",
                    )
                  }
                />
              </>
            )}
          </>
        ) : (
          <>
            {notice ? <AppText style={{ color: instrument.mut, fontSize: 13 }}>{notice}</AppText> : null}
            <BodyCompositionForm
              key="screenshot"
              ref={formRef}
              initialValues={screenshotInitialValues}
              initialReadingDate={screenshotInitialReadingDate}
              sources={screenshotSources}
              heightCm={heightCm}
              expandable
              initiallyExpanded
              submitting={addWeight.isPending}
              error={screenshotError}
              hideSubmitButton
              onSubmit={onScreenshotSubmit}
            />
          </>
        )}
      </View>
    </Sheet>
  );
}
