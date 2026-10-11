import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAIOrders } from "@/api/hooks";
import { rupees } from "@/api/aiUsage";
import type { AIOrder } from "@/api/types";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import { monoStyle } from "@/components/instrument/typography";
import { safeBack } from "@/lib/safeBack";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

const STATUS_LABEL: Record<AIOrder["status"], string> = {
  paid: "Paid",
  created: "Awaiting payment",
  failed: "Failed",
  expired: "Expired",
};

function orderDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function OrderRow({ order, last }: { order: AIOrder; last: boolean }) {
  const { instrument, fonts, spacing } = useTheme();
  const paid = order.status === "paid";
  return (
    <View
      accessible
      accessibilityLabel={`${order.pack_code}, ${STATUS_LABEL[order.status]}, ${rupees(order.total_paise)}`}
      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{order.pack_code}</AppText>
        <AppText style={[{ color: instrument.ink, fontSize: 15 }, monoStyle(fonts)]}>{rupees(order.total_paise)}</AppText>
      </View>
      <AppText style={{ color: paid ? instrument.mut : instrument.danger, fontSize: 12, marginTop: 3 }}>
        {STATUS_LABEL[order.status]} · {orderDate(order.paid_at ?? order.created_at)}
      </AppText>
      {/* The itemisation is the invoice: a GST bill has to show what tax was
          collected, not just the total that was charged. */}
      {paid ? (
        <AppText style={[{ color: instrument.mut, fontSize: 11, marginTop: 3 }, monoStyle(fonts)]}>
          {rupees(order.base_paise)} + {rupees(order.platform_fee_paise)} fee + {rupees(order.gst_paise)} GST
          {order.invoice_number ? ` · ${order.invoice_number}` : ""}
        </AppText>
      ) : null}
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

export default function AIInvoicesScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const orders = useAIOrders();

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 80 }}>
        <ScreenHeader overline="Agentic AI" title="Purchases" onBack={() => safeBack("/ai-top-up")} />
        <View style={{ paddingHorizontal: 20 }}>
          <BezelCluster testID="ai-invoices-cluster">
            {orders.isLoading ? (
              <View style={{ minHeight: 180, alignItems: "center", justifyContent: "center", gap: spacing.sm }}>
                <ActivityIndicator color={instrument.accent} />
                <AppText style={{ color: instrument.mut }}>Loading purchases…</AppText>
              </View>
            ) : orders.isError || !orders.data ? (
              <View style={{ minHeight: 180, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
                <AppText style={{ color: instrument.ink, textAlign: "center" }}>Couldn&apos;t load your purchases.</AppText>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  onPress={() => orders.refetch()}
                  style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, marginTop: spacing.sm }}
                >
                  <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Retry</AppText>
                </PressableScale>
              </View>
            ) : orders.data.length === 0 ? (
              <View style={{ minHeight: 180, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
                <AppText style={{ color: instrument.mut, textAlign: "center" }}>
                  You haven&apos;t bought a top-up yet.
                </AppText>
              </View>
            ) : (
              <>
                <ZoneRule label="Invoices" detail="incl. GST" />
                {orders.data.map((order, index) => (
                  <OrderRow key={order.id} order={order} last={index === orders.data.length - 1} />
                ))}
              </>
            )}
          </BezelCluster>
        </View>
      </ScrollView>
    </View>
  );
}
