import { useEffect, useRef, useState } from "react";
import { type TextInput, useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AuthSessionError, isAuthConfigured, signInWithPassword, signInWithProvider, type Provider } from "@/auth/session";
import { authErrorMessage, holdCredentials } from "@/auth/flow";
import { clearSnapshot } from "../modules/widget-bridge";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { BrandLockup } from "@/components/BrandLockup";
import { AuthScaffold } from "@/components/AuthScaffold";
import { Field } from "@/components/Field";
import { OrDivider } from "@/components/OrDivider";
import { SocialSignIn } from "@/components/SocialSignIn";
import { useTheme } from "@/theme";

// Above this font scale the hero gives up its subtitle (kora#173), so the
// form stays above the fold at accessibility sizes. 1.5 sits between iOS's
// largest non-accessibility size (~1.35) and its smallest accessibility one
// (~1.64). The brand lockup stays: it says which app is asking.
const HERO_COLLAPSE_FONT_SCALE = 1.5;

// Why the screen was opened, from the redirect that sent the person here.
const REASONS: Record<string, string> = {
  // api.ts's forced sign-out (a 401 that survived a token refresh), via the
  // redirect (tabs)/_layout.tsx makes; absent on a manual sign-out.
  expired: "Your session expired. Please sign in again.",
  // verify-email.tsx, when it has no password held to sign in with.
  verified: "Your email is confirmed. Sign in to continue.",
};

export default function SignIn() {
  const { colors, spacing } = useTheme();
  // Reactive, so the screen relays out when the user changes their text size
  // and returns to a still-mounted app (kora#260's pattern).
  const { fontScale } = useWindowDimensions();
  const compactHero = fontScale > HERO_COLLAPSE_FONT_SCALE;
  const { reason, email: emailParam } = useLocalSearchParams<{ reason?: string; email?: string }>();
  const [email, setEmail] = useState(emailParam ?? "");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(() => (reason ? (REASONS[reason] ?? null) : null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);

  // Belt-and-braces: useWidgetSync clears the snapshot on sign-out, but only
  // while the tabs layout is mounted to observe it. Landing here means
  // whatever session existed is over, so scrub on mount as an independent
  // guarantee.
  useEffect(() => {
    clearSnapshot();
  }, []);

  // After the last hook, so hook order cannot depend on it (#159).
  // app/_layout.tsx redirects to /config-missing before this mounts anyway.
  if (!isAuthConfigured) return null;

  // viaPassword: only a password sign-in can be refused for an unverified
  // email and continue on the code screen. A provider's unverified email is a
  // dead end with its own message.
  async function run(step: () => Promise<void>, viaPassword: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await step();
      router.replace("/");
    } catch (e: unknown) {
      if (viaPassword && e instanceof AuthSessionError && e.code === "email_not_verified") {
        // kora-api has just sent a fresh code. Hold the password so a correct
        // code signs straight in.
        const typed = email.trim();
        holdCredentials(typed, password);
        router.push({ pathname: "/verify-email", params: { email: typed } });
        return;
      }
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    void run(() => signInWithPassword(email.trim(), password), true);
  }

  function social(provider: Provider) {
    void run(() => signInWithProvider(provider), false);
  }

  return (
    <AuthScaffold
      footer={
        <View style={{ gap: spacing.xs }}>
          <Button
            testID="sign-in-submit"
            accessibilityLabel="Sign in"
            title={busy ? "…" : "Sign in"}
            icon="arrow-right"
            iconPosition="trailing"
            disabled={busy}
            onPress={submit}
          />
          <Button
            testID="sign-in-create"
            accessibilityLabel="Create account"
            title="New to Kora? Create account"
            variant="ghost"
            disabled={busy}
            onPress={() => router.push("/sign-up")}
          />
        </View>
      }
    >
      <BrandLockup />
      <AppText variant="title1" style={{ marginTop: compactHero ? 0 : spacing.sm }}>
        Welcome to Kora.
      </AppText>
      {compactHero ? null : <AppText muted>Sign in to pick up where you left off.</AppText>}

      {notice ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" muted>
          {notice}
        </AppText>
      ) : null}

      <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
        <Field
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
        <Field
          ref={passwordRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
          editable={!busy}
        />
        <Button
          testID="sign-in-forgot"
          title="Forgot password?"
          variant="ghost"
          disabled={busy}
          onPress={() => router.push({ pathname: "/reset-password", params: { email: email.trim() } })}
          style={{ alignSelf: "flex-end", minHeight: 36, paddingHorizontal: 0 }}
        />
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}

      <OrDivider />
      <SocialSignIn onPress={social} disabled={busy} />
    </AuthScaffold>
  );
}
