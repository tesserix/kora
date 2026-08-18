import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAIUsage } from "@/api/hooks";
import { availableAgainAt, remainingAIRequests } from "@/api/aiUsage";
import type { AIQuotaWindow } from "@/api/types";
import { AppBackground } from "@/components/AppBackground";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
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

export default function AIUsageScreen() {
  const { instrument, fonts, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const usage = useAIUsage();
  const remaining = usage.data ? remainingAIRequests(usage.data) : null;
  const availableAt = usage.data ? availableAgainAt(usage.data) : null;

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
                <View style={{ alignItems: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.xl }}>
                  <Icon name="sparkles" size={22} color={instrument.accent} />
                  <AppText
                    style={[
                      { color: instrument.ink, fontSize: availableAt ? 25 : 34, fontWeight: "700", marginTop: spacing.sm },
                      monoStyle(fonts),
                    ]}
                  >
                    {availableAt ? "AI limit reached" : `${remaining} calls left`}
                  </AppText>
                  <AppText style={{ color: instrument.mut, fontSize: 13, textAlign: "center", marginTop: spacing.xs }}>
                    {availableAt
                      ? `Available again ${resetText(availableAt)}`
                      : "The tightest active limit determines what is available."}
                  </AppText>
                </View>
                <ZoneRule label="Quota windows" />
                <UsageRow label="Daily" window={usage.data.daily} />
                <UsageRow label="Weekly" window={usage.data.weekly} />
                <UsageRow label="Monthly" window={usage.data.monthly} last />
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
