import { useEffect, useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { account, signInWithPassword } from "@/auth/session";
import { authErrorMessage, takeCredentials } from "@/auth/flow";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { AuthScaffold } from "@/components/AuthScaffold";
import { Field } from "@/components/Field";
import { safeBack } from "@/lib/safeBack";
import { useTheme } from "@/theme";

// How long "Send a new code" stays disabled after a send, so a double tap
// cannot spend the per-email send budget kora-api enforces.
const RESEND_COOLDOWN_S = 30;

export default function VerifyEmail() {
  const { colors, spacing } = useTheme();
  const { email = "" } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The screen opens straight after a send (sign-up, or a sign-in refused for
  // an unverified email), so it starts cooling down.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function submit() {
    if (busy) return;
    const typed = code.trim();
    if (!typed) {
      setError("Enter the code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await account.verifyEmail(email, typed);
      // Taken once: a failed sign-in below must not leave the password held.
      const held = takeCredentials(email);
      if (!held) {
        router.replace({ pathname: "/sign-in", params: { reason: "verified", email } });
        return;
      }
      await signInWithPassword(held.email, held.password);
      router.replace("/");
    } catch (e: unknown) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (busy || cooldown > 0) return;
    setError(null);
    setCooldown(RESEND_COOLDOWN_S);
    try {
      await account.resendCode(email);
      setNotice("A new code is on its way.");
    } catch (e: unknown) {
      setError(authErrorMessage(e));
    }
  }

  return (
    <AuthScaffold
      onBack={() => safeBack("/sign-in")}
      footer={
        <Button
          testID="verify-submit"
          accessibilityLabel="Confirm email"
          title={busy ? "…" : "Confirm email"}
          icon="arrow-right"
          iconPosition="trailing"
          disabled={busy}
          onPress={() => void submit()}
        />
      }
    >
      <AppText variant="title1">Check your email.</AppText>
      <AppText muted>
        We sent a code to <AppText style={{ fontWeight: "600" }}>{email}</AppText>. Enter it to confirm your address.
      </AppText>

      <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
        <Field
          label="Code"
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase())}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!busy}
          style={{ letterSpacing: 6, fontSize: 22 }}
        />
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}
      {notice ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" muted>
          {notice}
        </AppText>
      ) : null}

      <Button
        testID="verify-resend"
        title={cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
        variant="ghost"
        disabled={busy || cooldown > 0}
        onPress={() => void resend()}
        style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}
      />
    </AuthScaffold>
  );
}
