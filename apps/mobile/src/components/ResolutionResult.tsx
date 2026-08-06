import { Pressable } from "react-native";
import { AppText } from "@/components/Text";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { DetectedCard } from "@/components/capture/DetectedCard";
import { captureColors } from "@/components/capture/captureTheme";
import { kcalTotalLabel } from "@/lib/resolutionKcal";
import { isCachedResult } from "@/api/types";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import type { MealSlot } from "@/lib/mealSlot";

export type ResultView = "card" | "followUp" | "empty";

// Which of the three result presentations applies to a given resolution.
// A follow-up question always wins when present (the server is explicitly
// asking for clarification); otherwise an empty candidate list falls back to
// the generic "couldn't identify that" state; anything else has candidates
// worth showing in the DetectedCard.
export function resolveResultView(resolution: Resolution): ResultView {
  if (resolution.tier === "follow_up" && resolution.follow_up_question) {
    return "followUp";
  }
  if (resolution.candidates.length === 0) {
    return "empty";
  }
  return "card";
}

// The Otto summary bubble shown above the DetectedCard — total kcal is the
// server-reported estimate range when `is_estimate`, otherwise the sum of
// the candidates' own kcal (never a client-side recompute of nutrition).
export function resultSummary(resolution: Resolution): string {
  // A cache hit is a different kind of answer and must not read like a fresh
  // one: nothing was resolved just now, the device recognised a barcode it had
  // already seen. It also has no server-computed kcal, so the usual
  // "about N kcal" would be "about — kcal". Say what actually happened.
  //
  // Deliberately says NOTHING about when the calories arrive. This card shows
  // "—" because the client is forbidden from deriving nutrition here, but the
  // diary's own queued row (useQueuedLogs.toRow) derives a figure from the very
  // same cached record moments later and counts it in the day total — so any
  // promise of a later fill-in would describe an event that has already
  // happened by the time the user sees it.
  if (isCachedResult({ match_tier: resolution.provenance })) {
    const name = resolution.candidates[0]?.item.name ?? "that";
    return `You're offline — that's ${name}, from a scan you've done before. Confirm and I'll log it.`;
  }
  const count = resolution.candidates.length;
  const itemWord = count === 1 ? "item" : "items";
  const kcalText = kcalTotalLabel(resolution);
  return `I found ${count} ${itemWord}, about ${kcalText} — confirm and I'll log it.`;
}

// A stable per-candidate key for tracking add-to-diary success across retry
// attempts. Combines the candidate's position (stable for the lifetime of a
// single resolution) with its food_item_id (in case ids ever duplicate) so
// two candidates never collide.
export function candidateKey(candidate: ResolvedCandidate, index: number): string {
  return `${index}:${candidate.item.id}`;
}

// The fallback link shown alongside a follow-up question or an unidentified
// result — routes to the manual search/log screen instead of the AI flow.
function SearchManuallyLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Search manually"
      onPress={onPress}
      style={(state) => ({
        alignSelf: "flex-start",
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 9999,
        borderWidth: 1,
        borderColor: captureColors.outlineBorder,
        opacity: state.pressed ? 0.7 : 1,
      })}
    >
      <AppText style={{ color: captureColors.onSurface, fontSize: 14, fontWeight: "600" }}>Search manually</AppText>
    </Pressable>
  );
}

interface ResolutionResultProps {
  resolution: Resolution;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
  onSearchManually: () => void;
  /** Forwarded to DetectedCard — asked when the user taps an uncertain row. */
  onResolveUncertain?: (index: number) => void;
}

// The "here is what the AI thinks — confirm, correct, or answer a follow-up"
// surface. Purely presentational: it takes a resolution and callbacks, and has
// no opinion about where the resolution came from (a live resolve, or one
// stored alongside a queued capture and replayed later).
//
// Returns a Fragment on purpose — its children are direct children of the
// caller's scroll container, so the container's own `gap` keeps spacing them.
export function ResolutionResult({
  resolution,
  mealSlot,
  onChangeMealSlot,
  onAdd,
  adding,
  onSearchManually,
  onResolveUncertain,
}: ResolutionResultProps) {
  const resultView = resolveResultView(resolution);

  if (resultView === "card") {
    return (
      <>
        <OttoBubble>{resultSummary(resolution)}</OttoBubble>
        <DetectedCard
          resolution={resolution}
          mealSlot={mealSlot}
          onChangeMealSlot={onChangeMealSlot}
          onAdd={onAdd}
          adding={adding}
          onResolveUncertain={onResolveUncertain}
        />
      </>
    );
  }

  if (resultView === "followUp") {
    return (
      <>
        <OttoBubble>{resolution.follow_up_question}</OttoBubble>
        <SearchManuallyLink onPress={onSearchManually} />
      </>
    );
  }

  return (
    <>
      <OttoBubble>I couldn&apos;t identify that — try again or search manually.</OttoBubble>
      <SearchManuallyLink onPress={onSearchManually} />
    </>
  );
}
