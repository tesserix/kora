import { UNKNOWN_PROVENANCE } from "@/api/types";

const REFERENCE_SOURCES = new Set(["afcd", "ausnut", "ifct", "usda", "off"]);

export function foodProvenanceDescriptor(provenance: string | undefined): string | null {
  if (!provenance || provenance === UNKNOWN_PROVENANCE) return null;
  if (REFERENCE_SOURCES.has(provenance)) return "Verified";
  return provenance === "curated" ? "Recipe estimate" : "AI estimate";
}
