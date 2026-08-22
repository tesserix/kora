import { useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAIOrder, useAIPacks, useCreateAIOrder, useProfile } from "@/api/hooks";
import { rupees, ratePercent } from "@/api/aiUsage";
import type { AIOrder, AIPack } from "@/api/types";
import { AppBackground } from "@/components/AppBackground";
import { Field } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, WellFooter, ZoneRule } from "@/components/instrument/BezelCluster";
import { monoStyle } from "@/components/instrument/typography";
import { safeBack } from "@/lib/safeBack";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

// Cashfree requires a customer phone on every order. Ten digits is the only
// shape an Indian gateway will accept, and rejecting it here saves a round
// trip that ends in an opaque gateway error.
const PHONE_DIGITS = 10;

function isPayablePhone(phone: string): boolean {
  return /^[6-9]\d{9}$/.test(phone);
}

function PriceLine({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  const { instrument, fonts } = useTheme();
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
      <AppText style={{ color: strong ? instrument.ink : instrument.mut, fontSize: 13, fontWeight: strong ? "700" : "400" }}>
        {label}
      </AppText>
      <AppText
        style={[
          { color: strong ? instrument.ink : instrument.mut, fontSize: strong ? 15 : 13, fontWeight: strong ? "700" : "400" },
          monoStyle(fonts),
        ]}
      >
        {value}
      </AppText>
    </View>
  );
}

function PackRow({
  pack,
  selected,
  onSelect,
  last = false,
}: {
  pack: AIPack;
  selected: boolean;
  onSelect: () => void;
  last?: boolean;
}) {
  const { instrument, fonts, spacing } = useTheme();
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${pack.name}, ${pack.summary}, ${rupees(pack.price.total_paise)} including taxes`}
      onPress={onSelect}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        backgroundColor: selected ? instrument.inset : "transparent",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Icon
          name={selected ? "checkmark-circle" : "ellipse-outline"}
          size={20}
          color={selected ? instrument.accent : instrument.mut}
        />
        <View style={{ flex: 1 }}>
          <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{pack.name}</AppText>
          <AppText style={{ color: instrument.mut, fontSize: 12, marginTop: 2 }}>{pack.summary}</AppText>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <AppText style={[{ color: instrument.ink, fontSize: 16, fontWeight: "700" }, monoStyle(fonts)]}>
            {rupees(pack.price.total_paise)}
          </AppText>
          <AppText style={{ color: instrument.mut, fontSize: 11 }}>{rupees(pack.base_paise)} + taxes</AppText>
        </View>
      </View>
      {selected ? (
        <View style={{ marginTop: spacing.sm, gap: 4 }}>
          <PriceLine label="Pack price" value={rupees(pack.price.base_paise)} />
          <PriceLine
            label={`Platform fee (${ratePercent(pack.price.platform_fee_rate_basis_points)})`}
            value={rupees(pack.price.platform_fee_paise)}
          />
          <PriceLine label={`GST (${ratePercent(pack.price.gst_rate_basis_points)})`} value={rupees(pack.price.gst_paise)} />
          <PriceLine label="You pay" value={rupees(pack.price.total_paise)} strong />
        </View>
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
    </PressableScale>
  );
}

// What the user sees after checkout opens. The order is NOT paid because the
// app says so: it is paid when Cashfree's webhook settles it, which is what
// this poll is waiting for.
function OrderState({ order }: { order: AIOrder }) {
  const { instrument, fonts, spacing } = useTheme();
  if (order.status === "paid") {
    return (
      <View style={{ alignItems: "center", padding: spacing.lg, gap: spacing.xs }}>
        <Icon name="checkmark-circle" size={28} color={instrument.teal} />
        <AppText style={{ color: instrument.ink, fontWeight: "700" }}>Payment confirmed</AppText>
        <AppText style={{ color: instrument.mut, fontSize: 12, textAlign: "center" }}>
          Your requests are available now.
          {order.invoice_number ? ` Invoice ${order.invoice_number}.` : ""}
        </AppText>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Back to AI usage"
          onPress={() => safeBack("/ai-usage")}
          style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg }}
        >
          <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Back to AI usage</AppText>
        </PressableScale>
      </View>
    );
  }
  if (order.status === "created") {
    return (
      <View style={{ alignItems: "center", padding: spacing.lg, gap: spacing.xs }}>
        <ActivityIndicator color={instrument.accent} />
        <AppText style={{ color: instrument.ink, fontWeight: "600" }}>Waiting for confirmation</AppText>
        <AppText style={{ color: instrument.mut, fontSize: 12, textAlign: "center" }}>
          Finish the payment in the checkout window. This updates on its own — you can come back to it.
        </AppText>
        <AppText style={[{ color: instrument.mut, fontSize: 11, marginTop: 2 }, monoStyle(fonts)]}>
          {rupees(order.total_paise)} · {order.pack_code}
        </AppText>
      </View>
    );
  }
  return (
    <View style={{ alignItems: "center", padding: spacing.lg, gap: spacing.xs }}>
      <Icon name="alert-circle" size={26} color={instrument.danger} />
      <AppText style={{ color: instrument.ink, fontWeight: "700" }}>
        {order.status === "expired" ? "Checkout expired" : "Payment didn't go through"}
      </AppText>
      <AppText style={{ color: instrument.mut, fontSize: 12, textAlign: "center" }}>
        Nothing was charged. You can start again.
      </AppText>
    </View>
  );
}

export default function AITopUpScreen() {
  const { instrument, fonts, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const packs = useAIPacks();
  const profile = useProfile();
  const createOrder = useCreateAIOrder();
  const [selected, setSelected] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [orderID, setOrderID] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const order = useAIOrder(orderID);

  const chosen = packs.data?.find((pack) => pack.code === selected) ?? null;
  const canPay = Boolean(chosen) && isPayablePhone(phone) && !createOrder.isPending;

  async function pay() {
    if (!chosen) return;
    setCheckoutError(null);
    try {
      const created = await createOrder.mutateAsync({
        pack_code: chosen.code,
        phone,
        email: profile.data?.email,
      });
      setOrderID(created.id);
      // The gateway builds the checkout page; the app only opens it. If the
      // link cannot open, the order still exists and reconciles on its own.
      if (created.checkout_url) await Linking.openURL(created.checkout_url);
    } catch {
      setCheckoutError("Couldn't start the payment. Please try again.");
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 80 }}
      >
        <ScreenHeader overline="Agentic AI" title="Add requests" onBack={() => safeBack("/ai-usage")} />
        <View style={{ paddingHorizontal: 20 }}>
          <BezelCluster testID="ai-top-up-cluster">
            {orderID && order.data ? (
              <OrderState order={order.data} />
            ) : packs.isLoading ? (
              <View style={{ minHeight: 200, alignItems: "center", justifyContent: "center", gap: spacing.sm }}>
                <ActivityIndicator color={instrument.accent} />
                <AppText style={{ color: instrument.mut }}>Loading top-ups…</AppText>
              </View>
            ) : packs.isError || !packs.data || packs.data.length === 0 ? (
              <View style={{ minHeight: 200, alignItems: "center", justifyContent: "center", padding: spacing.lg }}>
                <AppText style={{ color: instrument.ink, textAlign: "center" }}>
                  Top-ups aren&apos;t available right now.
                </AppText>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel="Retry"
                  onPress={() => packs.refetch()}
                  style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, marginTop: spacing.sm }}
                >
                  <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Retry</AppText>
                </PressableScale>
              </View>
            ) : (
              <>
                <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.lg, paddingBottom: spacing.sm }}>
                  <AppText style={{ color: instrument.ink, fontSize: 15, fontWeight: "700" }}>
                    Your free allowance keeps running
                  </AppText>
                  <AppText style={{ color: instrument.mut, fontSize: 12, marginTop: 3 }}>
                    A top-up is only used once the free daily, weekly or monthly limit is spent, and it lasts 30 days.
                  </AppText>
                </View>
                <ZoneRule label="Top-ups" detail="incl. GST" />
                {packs.data.map((pack, index) => (
                  <PackRow
                    key={pack.code}
                    pack={pack}
                    selected={selected === pack.code}
                    onSelect={() => setSelected(pack.code)}
                    last={index === packs.data.length - 1}
                  />
                ))}
                <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.md }}>
                  <Field
                    label="Phone for the payment receipt"
                    value={phone}
                    onChangeText={(next) => setPhone(next.replace(/\D/g, "").slice(0, PHONE_DIGITS))}
                    keyboardType="number-pad"
                    placeholder="10-digit mobile number"
                    accessibilityLabel="Phone number"
                  />
                  {checkoutError ? (
                    <AppText style={{ color: instrument.danger, fontSize: 12, marginTop: spacing.xs }}>
                      {checkoutError}
                    </AppText>
                  ) : null}
                </View>
                <WellFooter testID="ai-top-up-footer">
                  <View style={{ flex: 1 }}>
                    <AppText style={{ color: instrument.mut, fontSize: 11 }}>
                      {chosen ? "Total incl. GST and platform fee" : "Choose a top-up"}
                    </AppText>
                    <AppText style={[{ color: instrument.ink, fontSize: 17, fontWeight: "700" }, monoStyle(fonts)]}>
                      {chosen ? rupees(chosen.price.total_paise) : "—"}
                    </AppText>
                  </View>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel="Pay securely"
                    accessibilityState={{ disabled: !canPay }}
                    disabled={!canPay}
                    onPress={pay}
                    style={{
                      minHeight: 44,
                      justifyContent: "center",
                      paddingHorizontal: spacing.lg,
                      borderRadius: 14,
                      opacity: canPay ? 1 : 0.45,
                      backgroundColor: instrument.accent,
                    }}
                  >
                    <AppText style={{ color: instrument.accentOn, fontWeight: "700" }}>
                      {createOrder.isPending ? "Opening…" : "Pay securely"}
                    </AppText>
                  </PressableScale>
                </WellFooter>
              </>
            )}
          </BezelCluster>
          <AppText style={{ color: instrument.mut, fontSize: 12, marginHorizontal: spacing.md, marginTop: spacing.sm }}>
            Payments are handled by Cashfree. Kora never sees your card. A GST invoice is issued for every paid top-up.
          </AppText>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="See past purchases"
            onPress={() => router.push("/ai-invoices")}
            style={{ minHeight: 44, justifyContent: "center", marginHorizontal: spacing.md, marginTop: spacing.xs }}
          >
            <AppText style={{ color: instrument.accent, fontWeight: "600" }}>See past purchases</AppText>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
  );
}
