import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Sheet } from "@/components/Sheet";
import { Button } from "@/components/Button";
import { Overline } from "@/components/Overline";
import { AppText } from "@/components/Text";
import { useToast } from "@/components/Toast";
import { useAddWeight, useReadBodyComposition } from "@/api/hooks";
import { ApiError } from "@/lib/api";
import { isOnline, useIsOnline } from "@/offline/connectivity";
import { COMPOSITION_METRICS } from "@/lib/bodyCompositionFields";
import { compositionValuesFromReading, type AddWeightPayload, type CompositionValues } from "@/lib/bodyCompositionForm";
import type { BodyCompositionDroppedField, BodyCompositionReadResult } from "@/api/types";
import { BodyCompositionForm } from "./BodyCompositionForm";
import { useTheme } from "@/theme";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Profile height, threaded through to BodyCompositionForm for BMI. */
  heightCm?: number;
}

type PhotoFile = { uri: string; name: string; type: string };
type PhotoPickOutcome =
  | { status: "success"; file: PhotoFile }
  | { status: "canceled" }
  | { status: "denied" }
  | { status: "failed" };

// A scale screenshot is, definitionally, already a photo — the reading came
// from the scale app's own share sheet or a manual screenshot, never from
// pointing the camera at the device's LCD. Unlike RecipeParseSheet's
// pickRecipePhoto (which tries the camera first), this only ever offers the
// library.
async function pickScaleScreenshot(): Promise<PhotoPickOutcome> {
  try {
    const libraryPermission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!libraryPermission.granted) return { status: "denied" };
    // `quality` cuts JPEG bytes before upload without a new native module —
    // see PR B's report for why this, and not expo-image-manipulator (which
    // would force a new dev-client build), is the downscale lever here. The
    // server downscales again before the provider call regardless
    // (api/internal/bodyread/service.go), so this is a bandwidth optimisation
    // only, not a correctness requirement.
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.5 });
    if (result.canceled) return { status: "canceled" };
    const asset = result.assets[0];
    if (!asset) return { status: "canceled" };
    return {
      status: "success",
      file: { uri: asset.uri, name: asset.fileName ?? "scale.jpg", type: asset.mimeType ?? "image/jpeg" },
    };
  } catch {
    return { status: "failed" };
  }
}

function droppedFieldLabel(field: string): string {
  if (field === "reading_date") return "reading date";
  const metric = COMPOSITION_METRICS.find((m) => m.key === field);
  return metric ? metric.label.toLowerCase() : field;
}

// Surfaced whenever a 200 comes back with anything dropped (kora#314 rule
// #11): a partial read that silently omitted three fields would look like
// the scale never showed them at all. Returns null when nothing was dropped,
// so an empty array renders no notice rather than an empty one.
export function droppedFieldsNotice(fields: readonly BodyCompositionDroppedField[]): string | null {
  if (fields.length === 0) return null;
  const labels = fields.map((f) => droppedFieldLabel(f.field));
  const joined = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  return `Your scale's ${joined} didn't look right on that screenshot, so ${labels.length === 1 ? "it was" : "they were"} left out — check it below.`;
}

// Each failure mode gets its own honest message, routed on `status` rather
// than `code` — see useParseRecipe's own comment in src/api/hooks.ts for why
// `status` is the reliable signal (a response body that fails to parse as
// JSON, e.g. behind a proxy hop, falls back to a "unknown" code but `status`
// is read off the response line before any body parsing happens).
export function readFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 422:
        return "Couldn't read anything from that screenshot. Enter your numbers below instead.";
      case 429:
        // Mirrors ai-usage.tsx's own "AI limit reached" register, and
        // RecipeParseSheet's 429 fallback copy — no retry offered, because
        // retrying immediately cannot succeed.
        return "You've reached an AI usage limit. Enter your numbers below — check AI usage in More to see when it resets.";
      case 503:
        return "The screenshot reader isn't available right now. Enter your numbers below instead.";
      default:
        return "Couldn't read that screenshot. Enter your numbers below instead.";
    }
  }
  // Network failure, timeout, or anything else that never got a real HTTP
  // response — same fallback offered either way: manual entry always works.
  return "Couldn't reach Kora to read that screenshot. Enter your numbers below instead.";
}

type Stage = "capture" | "form";

/**
 * The screenshot-import entry point for body composition (kora#314, PR B).
 *
 * Structured like RecipeParseSheet: an "entry" stage that captures input,
 * feeding a "review"-equivalent stage that is always reachable, success or
 * failure. Here that second stage is BodyCompositionForm itself — pre-filled
 * on a successful read, empty (with a notice explaining why) on any failure.
 * A metric the reader could not see is OMITTED from `initialValues`, never
 * defaulted to 0 (see compositionValuesFromReading).
 *
 * `sources` is always the single-entry `["scale_screenshot"]` — this sheet's
 * whole purpose is scale-screenshot logging, distinct from
 * BodyCompositionSheet's general manual entry, which keeps its own
 * `MANUAL_SOURCES` picker.
 */
export function BodyCompositionScanSheet({ visible, onClose, heightCm }: Props) {
  const { instrument, spacing } = useTheme();
  const toast = useToast();
  const online = useIsOnline();
  const readBodyComposition = useReadBodyComposition();
  const addWeight = useAddWeight();

  const [stage, setStage] = useState<Stage>("capture");
  const [notice, setNotice] = useState<string | null>(null);
  const [initialValues, setInitialValues] = useState<CompositionValues | undefined>(undefined);
  const [initialReadingDate, setInitialReadingDate] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reseed on every open, exactly like RecipeParseSheet — this sheet stays
  // mounted between opens (only Sheet's `visible` gate hides it), so a stale
  // read from a previous visit must never leak into the next one.
  useEffect(() => {
    if (!visible) return;
    setStage("capture");
    setNotice(null);
    setInitialValues(undefined);
    setInitialReadingDate(undefined);
    setSaveError(null);
  }, [visible]);

  function openManualFallback(explanation: string) {
    setInitialValues(undefined);
    setInitialReadingDate(undefined);
    setNotice(explanation);
    setStage("form");
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
    setInitialValues(compositionValuesFromReading(result.reading));
    setInitialReadingDate(result.reading.reading_date);
    setNotice(droppedFieldsNotice(result.dropped_fields));
    setStage("form");
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

  function onSubmit(payload: AddWeightPayload) {
    setSaveError(null);
    // payload.source is already "scale_screenshot" — BodyCompositionForm's
    // own single-entry `sources` array below fixes it, so there's nothing to
    // override here.
    addWeight.mutate(payload, {
      onSuccess: () => onClose(),
      onError: () => setSaveError("Couldn't save. Try again."),
    });
  }

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30, gap: spacing.md }}>
        {stage === "capture" ? (
          <>
            <Overline>Import from screenshot</Overline>
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
            <Overline>Confirm reading</Overline>
            {notice ? <AppText style={{ color: instrument.mut, fontSize: 13 }}>{notice}</AppText> : null}
            <BodyCompositionForm
              initialValues={initialValues}
              initialReadingDate={initialReadingDate}
              sources={["scale_screenshot"]}
              heightCm={heightCm}
              submitting={addWeight.isPending}
              error={saveError}
              onSubmit={onSubmit}
            />
          </>
        )}
      </View>
    </Sheet>
  );
}
