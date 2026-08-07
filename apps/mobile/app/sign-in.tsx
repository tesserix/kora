import { useState } from "react";
import { KeyboardAvoidingView, Platform, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type AuthCredential,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Segmented } from "@/components/Segmented";
import { BrandLockup } from "@/components/BrandLockup";
import { AuthScaffold } from "@/components/AuthScaffold";
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import { useTheme } from "@/theme";
import {
  signInWithAppleCredential,
  signInWithGoogleCredential,
  type SocialSignInOutcome,
} from "@/auth/socialCredentials";
import {
  configureGoogleSignin,
  signInWithAppleNative,
  signInWithGoogleNative,
} from "@/lib/socialAuth";
import { LinkAccountPrompt } from "@/components/auth/LinkAccountPrompt";

type Mode = "in" | "up";

const MODE_OPTIONS: Array<{ key: Mode; label: string }> = [
  { key: "in", label: "Sign in" },
  { key: "up", label: "Create account" },
];

export default function SignIn() {
  if (!isFirebaseConfigured) return null;

  const { colors, spacing, fontSize } = useTheme();
  // Set by api.ts's forced sign-out (a 401 that survived a token refresh)
  // via the redirect (tabs)/_layout.tsx makes when the session becomes
  // unusable — not present on a manual sign-out.
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  // Mode is explicit rather than inferred from which of two equally-weighted
  // buttons was pressed. The old screen greeted brand-new users with "Welcome
  // back" and had no way to word an error correctly for both paths.
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() =>
    reason === "expired" ? "Your session expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);
  const [pendingLink, setPendingLink] = useState<
    Extract<SocialSignInOutcome, { status: "needs-link" }> | null
  >(null);

  const filledInputStyle = {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
    minHeight: 48,
  } as const;

  async function submit() {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch (e: unknown) {
      setError(firebaseAuthMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function runSocial(fn: () => Promise<SocialSignInOutcome>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await fn();
      if (outcome.status === "needs-link") {
        setPendingLink(outcome);
        return;
      }
      router.replace("/");
    } catch (e: unknown) {
      // null means cancelled — clears any stale error and shows nothing new.
      setError(firebaseAuthMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function signInApple() {
    void runSocial(async () => {
      const { idToken, rawNonce, fullName } = await signInWithAppleNative();
      return signInWithAppleCredential(idToken, rawNonce, fullName);
    });
  }

  function signInGoogle() {
    void runSocial(async () => {
      configureGoogleSignin();
      return signInWithGoogleCredential(await signInWithGoogleNative());
    });
  }

  const cta = mode === "in" ? "Sign in" : "Create account";

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <AuthScaffold
        footer={
          <Button
            testID="auth-submit"
            title={busy ? "…" : cta}
            icon="arrow-right"
            iconPosition="trailing"
            onPress={submit}
            disabled={busy}
          />
        }
      >
        <BrandLockup />
        <AppText variant="title1" style={{ marginTop: spacing.sm }}>
          {mode === "in" ? "Welcome back." : "Start with Kora."}
        </AppText>
        <AppText muted>
          {mode === "in"
            ? "Sign in to pick up where you left off."
            : "Create an account and log your first meal in seconds."}
        </AppText>

        <View style={{ gap: spacing.sm }}>
          {Platform.OS === "ios" ? (
            <Button
              accessibilityLabel="Continue with Apple"
              title="Continue with Apple"
              disabled={busy}
              onPress={signInApple}
            />
          ) : null}
          <Button
            accessibilityLabel="Continue with Google"
            title="Continue with Google"
            variant="secondary"
            disabled={busy}
            onPress={signInGoogle}
          />
        </View>

        <Segmented
          options={MODE_OPTIONS}
          value={mode}
          onChange={(key) => {
            setMode(key as Mode);
            // An error raised by the other mode no longer applies, and would
            // read as a failure of the action just switched to.
            setError(null);
          }}
        />

        <View style={{ gap: spacing.sm }}>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Email"
              style={filledInputStyle}
              placeholder="Email"
              placeholderTextColor={colors.secondaryLabel}
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
          </Card>
          <Card variant="elevated" style={{ padding: 0 }}>
            <TextInput
              accessibilityLabel="Password"
              style={filledInputStyle}
              placeholder="Password"
              placeholderTextColor={colors.secondaryLabel}
              secureTextEntry
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              textContentType={mode === "in" ? "password" : "newPassword"}
              value={password}
              onChangeText={setPassword}
            />
          </Card>
        </View>

        {error ? (
          <AppText
            variant="footnote"
            accessibilityLiveRegion="polite"
            style={{ color: colors.destructive }}
          >
            {error}
          </AppText>
        ) : null}

        {pendingLink ? (
          <LinkAccountPrompt
            visible
            email={pendingLink.email}
            provider={pendingLink.provider}
            pendingCredential={pendingLink.pendingCredential as AuthCredential}
            onCancel={() => setPendingLink(null)}
            onLinked={() => {
              setPendingLink(null);
              router.replace("/");
            }}
          />
        ) : null}
      </AuthScaffold>
    </KeyboardAvoidingView>
  );
}
