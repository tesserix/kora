import { useRef, useState } from "react";
import { Linking, type TextInput, View } from "react-native";
import { router } from "expo-router";
import { account, signInWithProvider, type Provider } from "@/auth/session";
import { authErrorMessage, holdCredentials, passwordProblem, PASSWORD_RULES } from "@/auth/flow";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { AuthScaffold } from "@/components/AuthScaffold";
import { Field } from "@/components/Field";
import { OrDivider } from "@/components/OrDivider";
import { SocialSignIn } from "@/components/SocialSignIn";
import { safeBack } from "@/lib/safeBack";
import { useTheme } from "@/theme";

const TERMS_URL = "https://tesserix.app/terms";
const PRIVACY_URL = "https://tesserix.app/privacy";

export default function SignUp() {
  const { colors, instrument, spacing } = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit() {
    if (busy) return;
    const typed = email.trim();
    if (!name.trim() || !typed || !password) {
      setError("Enter your name, email and a password.");
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await account.signUp(name.trim(), typed, password);
      holdCredentials(typed, password);
      router.replace({ pathname: "/verify-email", params: { email: typed } });
    } catch (e: unknown) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function social(provider: Provider) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithProvider(provider);
      router.replace("/");
    } catch (e: unknown) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold
      onBack={() => safeBack("/sign-in")}
      footer={
        <Button
          testID="sign-up-submit"
          accessibilityLabel="Create account"
          title={busy ? "…" : "Create account"}
          icon="arrow-right"
          iconPosition="trailing"
          disabled={busy}
          onPress={() => void submit()}
        />
      }
    >
      <AppText variant="title1">Create your account.</AppText>
      <AppText muted>{"We'll email you a code to confirm it's you."}</AppText>

      <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          onSubmitEditing={() => emailRef.current?.focus()}
          editable={!busy}
        />
        <Field
          ref={emailRef}
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          editable={!busy}
        />
        <View style={{ gap: 6 }}>
          <Field
            ref={passwordRef}
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            // iOS strong-password suggestions follow these, so a suggested
            // password always satisfies Zitadel's policy.
            passwordRules="minlength: 12; maxlength: 69; required: upper; required: lower; required: digit; required: special;"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            editable={!busy}
          />
          <AppText variant="footnote" muted>
            {PASSWORD_RULES}
          </AppText>
        </View>
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}

      <AppText variant="footnote" muted>
        By creating an account you agree to the{" "}
        <AppText variant="footnote" style={{ color: instrument.accent }} onPress={() => void Linking.openURL(TERMS_URL)}>
          Terms
        </AppText>{" "}
        and{" "}
        <AppText variant="footnote" style={{ color: instrument.accent }} onPress={() => void Linking.openURL(PRIVACY_URL)}>
          Privacy Policy
        </AppText>
        .
      </AppText>

      <OrDivider />
      <SocialSignIn onPress={(p) => void social(p)} disabled={busy} />
    </AuthScaffold>
  );
}
