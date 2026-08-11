import { View } from "react-native";
import { AppText } from "./Text";
import { BrandMark } from "./BrandMark";
import { useTheme } from "@/theme";

// The Kora brand lockup: the dial-K mark beside the wordmark. Shown at the
// top of the pre-app screens (sign-in and onboarding step 1).
//
// The mark's source of truth is the geometry in BrandMark.tsx, shared with the
// generated assets in assets/brand/. The mark sits directly on the screen
// background — no filled tile; the brand rules keep the needle and hub as the
// only accent-colored elements.
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
