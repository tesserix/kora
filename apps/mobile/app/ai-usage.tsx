import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAIPacks, useAIUsage } from "@/api/hooks";
import { aiAllowance } from "@/api/aiUsage";
import type { AIQuotaWindow, AITopUpStatus, AIUsageStatus } from "@/api/types";
import { AppBackground } from "@/components/AppBackground";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, WellFooter, ZoneRule } from "@/components/instrument/BezelCluster";
import { monoStyle } from "@/components/instrument/typography";
import { safeBack } from "@/lib/safeBack";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

function resetText(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function UsageRow({ label, window, last = false }: { label: string; window: AIQuotaWindow; last?: boolean }) {
  const { instrument, fonts, spacing } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${window.used} of ${window.limit} used, ${window.remaining} remaining`}
      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{label}</AppText>
        <AppText style={[{ color: instrument.ink, fontSize: 15 }, monoStyle(fonts)]}>
          {window.used} / {window.limit}
        </AppText>
      </View>
      <AppText style={{ color: instrument.mut, fontSize: 12, marginTop: 3 }}>
        {window.remaining} remaining · resets {resetText(window.resets_at)}
      </AppText>
      {!last ? (
        <View
          style={{
            position: "absolute",
            left: spacing.md,
            right: spacing.md,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: instrument.hairline,
          }}
        />
      ) : null}
    </View>
  );
}

function Hero({ status }: { status: AIUsageStatus }) {
  const { instrument, fonts, spacing } = useTheme();
  const allowance = aiAllowance(status);
  return (
    <View style={{ alignItems: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xl }}>
      <Icon name="sparkles" size={22} color={instrument.accent} />
      <AppText
        style={[
          { color: instrument.ink, fontSize: allowance.blocked ? 25 : 34, fontWeight: "700", marginTop: spacing.sm },
          monoStyle(fonts),
        ]}
      >
        {allowance.headline}
      </AppText>
      <AppText style={{ color: instrument.mut, fontSize: 13, textAlign: "center", marginTop: spacing.xs }}>
        {allowance.detail}
      </AppText>
    </View>
  );
}

function TopUpRow({ topUp }: { topUp: AITopUpStatus }) {
  const { instrument, fonts, spacing } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        topUp.unlimited
          ? "Top-up active: unlimited requests"
          : `Top-up active: ${topUp.remaining} requests left, ${topUp.daily_remaining} today`
      }
      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
        <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{topUp.pack_code ?? "Top-up"}</AppText>
        <AppText style={[{ color: instrument.ink, fontSize: 15 }, monoStyle(fonts)]}>
          {topUp.unlimited ? "unlimited" : `${topUp.remaining} left`}
        </AppText>
      </View>
      <AppText style={{ color: instrument.mut, fontSize: 12, marginTop: 3 }}>
        {topUp.unlimited ? "No daily cap" : `${topUp.daily_remaining} available today`}
        {topUp.expires_at ? ` · expires ${resetText(topUp.expires_at)}` : ""}
      </AppText>
    </View>
  );
}

export default function AIUsageScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const usage = useAIUsage();
  const blocked = usage.data ? aiAllowance(usage.data).blocked : false;
  const topUp = usage.data?.top_up?.active ? usage.data.top_up : null;
  // Payments mount only where Cashfree is configured, so this answers 404 in
  // an environment without it. Offering to sell something that cannot be
  // bought is worse than not offering it.
  const packs = useAIPacks();
  const canBuy = (packs.data?.length ?? 0) > 0;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 80 }}>
        <ScreenHeader overline="Agentic AI" title="AI usage" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20 }}>
          <BezelCluster testID="ai-usage-cluster">
            {usage.isLoading ? (
              <View style={{ minHeight: 240, alignItems: "center", justifyContent: "center", gap: spacing.sm }}>
                <ActivityIndicator color={instrument.accent} />
                <AppText style={{ color: instrument.mut }}>Loading AI usage…</AppText>
              </View>
            ) : usage.isError || !usage.data ? (
              <View style={{ minHeight: 240, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
                <AppText style={{ color: instrument.ink, textAlign: "center" }}>Couldn&apos;t load your AI usage.</AppText>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  onPress={() => usage.refetch()}
                  style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, marginTop: spacing.sm }}
                >
                  <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Retry</AppText>
                </PressableScale>
              </View>
            ) : (
              <>
                <Hero status={usage.data} />
                <ZoneRule label="Free allowance" detail="resets automatically" />
                <UsageRow label="Daily" window={usage.data.daily} />
                <UsageRow label="Weekly" window={usage.data.weekly} />
                <UsageRow label="Monthly" window={usage.data.monthly} last />
                {topUp ? (
                  <>
                    <ZoneRule label="Top-up" detail="30 days" />
                    <TopUpRow topUp={topUp} />
                  </>
                ) : null}
                {canBuy ? (
                  <WellFooter testID="ai-usage-footer">
                    <AppText style={{ flex: 1, color: instrument.mut, fontSize: 12 }}>
                      {blocked ? "Out of requests" : "Need more than the free allowance?"}
                    </AppText>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel="Add requests"
                      onPress={() => router.push("/ai-top-up")}
                      style={{
                        minHeight: 44,
                        justifyContent: "center",
                        paddingHorizontal: spacing.lg,
                        borderRadius: 14,
                        backgroundColor: blocked ? instrument.accent : "transparent",
                      }}
                    >
                      <AppText
                        style={{ color: blocked ? instrument.accentOn : instrument.accent, fontWeight: "700" }}
                      >
                        Add requests
                      </AppText>
                    </PressableScale>
                  </WellFooter>
                ) : null}
              </>
            )}
          </BezelCluster>
          <AppText style={{ color: instrument.mut, fontSize: 13, marginHorizontal: spacing.md, marginTop: spacing.sm }}>
            Cached matches and manual food search do not use this allowance.
          </AppText>
        </View>
      </ScrollView>
    </View>
  );
}
