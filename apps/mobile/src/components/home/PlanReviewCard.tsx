import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import type { Profile } from "@/api/types";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

// One-time nudge for people who onboarded before the Plan page existed
// (plan_saved_at is NULL for them). Saving a plan or tapping X ends it.
export function PlanReviewCard({ profile }: { profile: Profile | undefined }) {
  const { instrument, spacing } = useTheme();
  const key = profile ? `kora.planReview.dismissed.${profile.id}` : null;
  // null = not yet read; render nothing until known so a dismissed card never flashes.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    AsyncStorage.getItem(key).then(
      (v) => live && setDismissed(v === "1"),
      () => live && setDismissed(false),
    );
    return () => {
      live = false;
    };
  }, [key]);

  if (!profile || !profile.onboarded_at || profile.plan_saved_at || dismissed !== false) return null;

  return (
    <View
      style={{
        minHeight: 64,
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingVertical: 10,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: instrument.hairline,
      }}
    >
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Check your plan. We&apos;ve improved how protein is worked out. Take a look."
        haptic="selection"
        onPress={() => router.push("/plan")}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.sm }}
      >
        <View style={{ flex: 1 }}>
          <AppText style={{ color: instrument.ink, fontSize: 14, fontWeight: "600" }}>Check your plan</AppText>
          <AppText style={{ color: instrument.mut, fontSize: 13, marginTop: 2 }}>
            We&apos;ve improved how protein is worked out. Take a look.
          </AppText>
        </View>
        <Icon name="chevron-right" size={15} color={instrument.mut} />
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        haptic="none"
        onPress={() => {
          setDismissed(true);
          AsyncStorage.setItem(key!, "1").catch(() => {});
        }}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="x" size={16} color={instrument.mut} />
      </PressableScale>
    </View>
  );
}
