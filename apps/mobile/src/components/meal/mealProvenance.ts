export { foodProvenanceDescriptor as provenanceDescriptor } from "@/lib/foodProvenance";

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
