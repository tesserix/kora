import { useState } from "react";
import { KeyboardAvoidingView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type AuthCredential,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { BrandLockup } from "@/components/BrandLockup";
import { AuthScaffold } from "@/components/AuthScaffold";
import { AppleSignInButton } from "@/components/auth/AppleSignInButton";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import { useTheme } from "@/theme";
import { PressableScale } from "@/motion";
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

export default function SignIn() {
  if (!isFirebaseConfigured) return null;

  const { colors, spacing } = useTheme();
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
  const [showEmail, setShowEmail] = useState(false);

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

  async function runSocial(
    fn: () => Promise<SocialSignInOutcome>,
    provider: "google.com" | "apple.com",
  ) {
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
      // Tagged "social" so firebaseAuthMessage never renders password copy for
      // a screen where no password was entered (e.g. auth/invalid-credential,
      // which is what a not-yet-enabled provider throws).
      setError(firebaseAuthMessage(e, { method: "social", provider }));
    } finally {
      setBusy(false);
    }
  }

  function signInApple() {
    void runSocial(async () => {
      const { idToken, rawNonce, fullName, authorizationCode } = await signInWithAppleNative();
      return signInWithAppleCredential(idToken, rawNonce, fullName, authorizationCode);
    }, "apple.com");
  }

  function signInGoogle() {
    void runSocial(async () => {
      configureGoogleSignin();
      return signInWithGoogleCredential(await signInWithGoogleNative());
    }, "google.com");
  }

  const cta = mode === "in" ? "Sign in" : "Create account";
  // Firebase/Apple console setup for this branch hasn't happened yet: no Google
  // OAuth client IDs exist, and configureGoogleSignin() throws when this is
  // empty. Rendering the button anyway would ship a control that can only
  // fail — same precedent as the `!isFirebaseConfigured` guard above.
  const googleConfigured = Boolean(process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID);

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <AuthScaffold
        footer={
          <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
            <AppText muted variant="footnote">
              {mode === "in" ? "New here?" : "Already have an account?"}
            </AppText>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={mode === "in" ? "Create an account" : "Sign in"}
              haptic="selection"
              hitSlop={12}
              onPress={() => {
                setMode(mode === "in" ? "up" : "in");
                // An error raised by the other mode no longer applies, and would
                // read as a failure of the action just switched to.
                setError(null);
                // On first paint, with the email form hidden, this link only
                // moved a heading ~400px above the tap — the tap appeared to do
                // nothing. Revealing the form gives feedback at the touch point.
                setShowEmail(true);
              }}
            >
              <AppText variant="footnote" style={{ color: colors.primary, fontWeight: "600" }}>
                {mode === "in" ? "Create an account" : "Sign in"}
              </AppText>
            </PressableScale>
          </View>
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

        {/* Collapsible: the email reveal grows downward, so the lockup stays
            top-anchored and this spacer shrinks instead of the lockup jumping
            to stay centred. minHeight is what lets it collapse once content
            (the form, the keyboard) needs the room. */}
        <View style={{ flex: 1, minHeight: spacing.xl }} />

        <View style={{ gap: spacing.sm }}>
          <AppleSignInButton
            accessibilityLabel="Continue with Apple"
            disabled={busy}
            onPress={signInApple}
          />
          {googleConfigured ? (
            <GoogleSignInButton
              accessibilityLabel="Continue with Google"
              title="Continue with Google"
              disabled={busy}
              onPress={signInGoogle}
            />
          ) : null}
        </View>

        {/* A social failure belongs under the providers it came from, not
            beneath the unrelated email affordance below. */}
        {error ? (
          <AppText
            variant="footnote"
            accessibilityLiveRegion="polite"
            style={{ color: colors.destructive }}
          >
            {error}
          </AppText>
        ) : null}

        {showEmail ? (
          <View style={{ gap: spacing.sm }}>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              keyboardType="email-address"
              autoFocus
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              textContentType={mode === "in" ? "password" : "newPassword"}
            />
            {/* The submit sits next to its own fields. AuthScaffold's sticky
                footer no longer carries it, which is what fixes the stranded
                primary action. */}
            <Button
              testID="auth-submit"
              accessibilityLabel={cta}
              title={busy ? "…" : cta}
              icon="arrow-right"
              iconPosition="trailing"
              onPress={submit}
              disabled={busy}
            />
          </View>
        ) : (
          // A peer of the two provider buttons, not an escape hatch — same
          // width and height, but the secondary/outline treatment (no green)
          // since the accent is reserved for the action Kora wants taken.
          <Button
            accessibilityLabel="Continue with email"
            title="Continue with email"
            variant="secondary"
            disabled={busy}
            onPress={() => setShowEmail(true)}
            style={{
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.border,
              opacity: busy ? 0.6 : 1,
              minHeight: 48,
            }}
          />
        )}

        <View style={{ minHeight: spacing.sm }} />

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
