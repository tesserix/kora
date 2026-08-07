import { View } from "react-native";
import { AppText } from "./Text";
import { BrandMark } from "./BrandMark";
import { useTheme } from "@/theme";

// The Kora brand lockup: the dot-grid mark beside the wordmark. Shown at the
// top of the pre-app screens (sign-in and onboarding step 1).
//
// The mark's source of truth is assets/images/icon.png, NOT
// design-system/ui_kits/kora/Onboarding.jsx — that kit rendered a Lucide
// `sparkles` glyph in a filled tile, which was never Kora's mark. The kit has
// been corrected to match; if the two ever disagree again, the icon wins.
//
// There is no filled tile any more: icon.png is dots on a near-black field,
// and `background` is exactly that field, so a tile would be invisible at best
// and would fight the mark's own green at worst.
export function BrandLockup() {
  const { spacing } = useTheme();

  return (
    <View
      accessibilityRole="header"
      accessibilityLabel="Kora"
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm + 2 }}
    >
      <BrandMark size={40} />
      <AppText variant="title2" style={{ letterSpacing: -0.4 }}>
        Kora
      </AppText>
    </View>
  );
}
