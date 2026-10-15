import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { AuthSessionError, completeTOTP } from "@/auth/session";
import { authErrorMessage } from "@/auth/flow";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { AuthScaffold } from "@/components/AuthScaffold";
import { Field } from "@/components/Field";
import { useTheme } from "@/theme";

// The second step for an account with an authenticator app. kora-api holds
// the half-finished sign-in for five minutes and five codes; after either the
// person signs in again from the start.
export default function TwoStep() {
  const { colors, spacing } = useTheme();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const digits = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError("The code is 6 digits. Check your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeTOTP(digits);
      router.replace("/");
    } catch (e: unknown) {
      if (e instanceof AuthSessionError && e.code === "challenge_expired") setExpired(true);
      setCode("");
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const startOver = () => router.replace("/sign-in");

  return (
    <AuthScaffold
      onBack={startOver}
      footer={
        expired ? (
          <Button testID="two-step-restart" title="Sign in again" onPress={startOver} />
        ) : (
          <Button
            testID="two-step-submit"
            accessibilityLabel="Verify"
            title={busy ? "…" : "Verify"}
            icon="arrow-right"
            iconPosition="trailing"
            disabled={busy}
            onPress={() => void submit()}
          />
        )
      }
    >
      <AppText variant="title1">Two-step verification.</AppText>
      <AppText muted>Enter the 6-digit code from your authenticator app.</AppText>

      <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
        <Field
          label="Code"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={7}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!busy && !expired}
          autoFocus
          style={{ letterSpacing: 6, fontSize: 22 }}
        />
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}
    </AuthScaffold>
  );
}
