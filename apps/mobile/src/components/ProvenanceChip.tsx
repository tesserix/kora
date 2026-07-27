import { View } from "react-native";
import { AppText } from "./Text";
import { useTheme } from "@/theme";

const VERIFIED = new Set(["afcd", "off", "usda"]);

export function ProvenanceChip({ provenance }: { provenance: string }) {
  const { colors, radius, spacing, fontSize } = useTheme();
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
