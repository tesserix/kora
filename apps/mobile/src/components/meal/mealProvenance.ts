import { UNKNOWN_PROVENANCE } from "@/api/types";

// Same verified-source set ProvenanceChip (src/components/ProvenanceChip.tsx)
// uses for its "verified" vs "AI estimate ±15%" split. Duplicated here rather
// than importing ProvenanceChip and restyling it in place: that component is
// also used by app/log.tsx (a food-SEARCH result, a different shape of claim)
// and is asserted against directly by
// src/components/__tests__/dashboard-widgets.test.tsx, so changing its
// rendering would change behavior for those other callers. app/meal.tsx's
// chip is composed inline instead — see task-12 report for the tradeoff.
const VERIFIED_PROVENANCE = new Set(["afcd", "off", "usda"]);

export function provenanceDescriptor(provenance: string | undefined): string | null {
  if (!provenance || provenance === UNKNOWN_PROVENANCE) return null;
  return VERIFIED_PROVENANCE.has(provenance) ? "Verified" : "AI estimate";
}

const SOURCE_LABELS: Record<string, string> = {
  ai_photo: "Photo",
  ai_voice: "Voice",
  ai_text: "Text",
  ai_barcode: "Barcode",
  barcode: "Barcode",
  manual: "Manual",
  saved_meal: "Saved meal",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function sourceLabel(source: string | undefined): string | null {
  if (!source) return null;
  return SOURCE_LABELS[source] ?? cap(source.replace(/_/g, " "));
}
