import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";
import { UNKNOWN_PROVENANCE } from "@/api/types";

const VERIFIED = new Set(["afcd", "off", "usda"]);

export function ProvenanceChip({ provenance }: { provenance: string }) {
  const { colors, radius, spacing, fontSize } = useTheme();
  // An unknown/synthesized provenance (e.g. an offline-cache entry whose
  // original source wasn't carried through) must render nothing rather than
  // fall through to the "AI estimate ±15%" copy below — that copy means a
  // model's own guess, which is not what this is: the macros are an exact
  // reverse-scale of real numbers, just from an unrecorded source.
  if (!provenance || provenance === UNKNOWN_PROVENANCE) return null;
  const isVerified = VERIFIED.has(provenance);
  const label = isVerified ? `${provenance.toUpperCase()} · verified` : "AI estimate ±15%";
  const bg = isVerified ? colors.secondary : colors.cardSecondary;
  const fg = isVerified ? colors.secondaryForeground : colors.mutedForeground;
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: bg, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2 }}>
      <AppText style={{ color: fg, fontSize: fontSize.xs }}>{label}</AppText>
    </View>
  );
}
