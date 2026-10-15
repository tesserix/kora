import { useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { account, signInWithPassword } from "@/auth/session";
import { authErrorMessage, needsSecondFactor, passwordProblem, PASSWORD_RULES } from "@/auth/flow";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { AuthScaffold } from "@/components/AuthScaffold";
import { Field } from "@/components/Field";
import { safeBack } from "@/lib/safeBack";
import { useTheme } from "@/theme";

// Two steps on one screen: ask for the email, then take the emailed code and
// the new password together. A reset signs straight in with the new password.
export default function ResetPassword() {
  const { colors, spacing } = useTheme();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? "");
  const [step, setStep] = useState<"email" | "code">("email");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attempt(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e: unknown) {
      // The new password is set by now; only the sign-in after it stopped.
      if (needsSecondFactor(e)) {
        router.replace("/two-step");
        return;
      }
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function send() {
    const typed = email.trim();
    if (!typed) {
      setError("Enter the email you signed up with.");
      return;
    }
    void attempt(async () => {
      // kora-api answers the same whether or not the account exists, so this
      // screen says "if", never "we sent".
      await account.requestPasswordReset(typed);
      setEmail(typed);
      setStep("code");
    });
  }

  function confirm() {
    if (!code.trim() || !password) {
      setError("Enter the code and a new password.");
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    void attempt(async () => {
      await account.confirmPasswordReset(email, code.trim(), password);
      await signInWithPassword(email, password);
      router.replace("/");
    });
  }

  const onCode = step === "code";
  return (
    <AuthScaffold
      onBack={() => (onCode ? setStep("email") : safeBack("/sign-in"))}
      footer={
        <Button
          testID="reset-submit"
          accessibilityLabel={onCode ? "Set new password" : "Send reset code"}
          title={busy ? "…" : onCode ? "Set new password" : "Send reset code"}
          icon="arrow-right"
          iconPosition="trailing"
          disabled={busy}
          onPress={onCode ? confirm : send}
        />
      }
    >
      <AppText variant="title1">{onCode ? "Choose a new password." : "Reset your password."}</AppText>
      <AppText muted>
        {onCode
          ? `If ${email} has a Kora account, we've emailed it a code. Enter it with your new password.`
          : "Enter your email and we'll send you a code to set a new password."}
      </AppText>

      <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
        {onCode ? (
          <>
            <Field
              label="Code"
              value={code}
              onChangeText={(v) => setCode(v.toUpperCase())}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              editable={!busy}
              style={{ letterSpacing: 6, fontSize: 22 }}
            />
            <View style={{ gap: 6 }}>
              <Field
                label="New password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                passwordRules="minlength: 12; maxlength: 69; required: upper; required: lower; required: digit; required: special;"
                returnKeyType="go"
                onSubmitEditing={confirm}
                editable={!busy}
              />
              <AppText variant="footnote" muted>
                {PASSWORD_RULES}
              </AppText>
            </View>
          </>
        ) : (
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            returnKeyType="go"
            onSubmitEditing={send}
            editable={!busy}
          />
        )}
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}
    </AuthScaffold>
  );
}
