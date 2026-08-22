import * as ImagePicker from "expo-image-picker";
import { ApiError } from "@/lib/api";
import { COMPOSITION_METRICS } from "@/lib/bodyCompositionFields";
import type { BodyCompositionDroppedField } from "@/api/types";

/**
 * Pure/testable helpers behind the screenshot-import mode of `LogWeightSheet`
 * (kora#314 PR C). Split out of the old `BodyCompositionScanSheet` so the
 * sheet itself stays a thin owner of mode/stage state — these functions carry
 * no component state and don't need a render tree to exercise.
 */

export type PhotoFile = { uri: string; name: string; type: string };
export type PhotoPickOutcome =
  | { status: "success"; file: PhotoFile }
  | { status: "canceled" }
  | { status: "denied" }
  | { status: "failed" };

// A scale screenshot is, definitionally, already a photo — the reading came
// from the scale app's own share sheet or a manual screenshot, never from
// pointing the camera at the device's LCD. Unlike RecipeParseSheet's
// pickRecipePhoto (which tries the camera first), this only ever offers the
// library.
export async function pickScaleScreenshot(): Promise<PhotoPickOutcome> {
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
