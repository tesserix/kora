import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { AppBackground } from "@/components/AppBackground";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

// Where Cashfree's hosted checkout sends the user back to (CASHFREE_RETURN_URL,
// `mobile://billing/return`). It carries a payment result, and this screen
// deliberately reads NONE of it: the deep link is forgeable, so the allowance
// shown next comes from the server, which settles from the signed webhook or
// its own status fetch.
//
// The only job here is to drop the stale allowance and orders and hand the
// user back to the usage screen, which reads whatever actually happened.
export default function BillingReturnScreen() {
  const { instrument, spacing } = useTheme();
  const qc = useQueryClient();

  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["ai-usage"] });
    qc.invalidateQueries({ queryKey: ["ai-orders"] });
    qc.invalidateQueries({ queryKey: ["ai-order"] });
    router.replace("/ai-usage");
  }, [qc]);

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg, alignItems: "center", justifyContent: "center", gap: spacing.sm }}>
      <AppBackground />
      <ActivityIndicator color={instrument.accent} />
      <AppText style={{ color: instrument.mut }}>Checking your payment…</AppText>
    </View>
  );
}
