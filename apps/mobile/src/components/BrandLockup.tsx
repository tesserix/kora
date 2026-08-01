import { View } from "react-native";
import { AppText } from "./Text";
import { Icon } from "./Icon";
import { useTheme } from "@/theme";

// The Kora brand lockup from design-system/ui_kits/kora/Onboarding.jsx: a filled
// primary tile carrying the sparkles mark, beside the wordmark. Shown at the top
// of the pre-app screens (sign-in and onboarding step 1) so the flow is
// recognisably Kora before the user has an account — the shipped screens carried
// no brand mark at all.
export function BrandLockup() {
  const { colors, radius, shadows } = useTheme();

  return (
    <View
      accessibilityRole="header"
      style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
    >
      <View
        testID="brand-mark-tile"
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.lg,
          backgroundColor: colors.primary,
          alignItems: "center",
          justifyContent: "center",
          ...shadows.md,
        }}
      >
        <Icon name="sparkles" size={22} color={colors.primaryForeground} />
      </View>
      <AppText variant="title2" style={{ letterSpacing: -0.4 }}>
        Kora
      </AppText>
    </View>
  );
}
