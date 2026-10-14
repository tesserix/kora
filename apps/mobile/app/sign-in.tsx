import { useEffect, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { AuthSessionError, isAuthConfigured, signIn } from "@/auth/session";
import { clearSnapshot } from "../modules/widget-bridge";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { BrandLockup } from "@/components/BrandLockup";
import { AuthScaffold } from "@/components/AuthScaffold";
import { useTheme } from "@/theme";

// Ceiling for the collapsible gap between the lockup and the buttons
// (kora#172). Not a spacing token on purpose: it is the measured height that
// gap settles at on the narrowest device we support, captured so that taller
// screens stop inflating it.
const SIGN_IN_TOP_GAP_MAX = 248;

// Above this font scale the hero gives up its subtitle (kora#173), so both
// buttons stay above the fold at accessibility sizes. 1.5 sits between iOS's
// largest non-accessibility size (~1.35) and its smallest accessibility one
// (~1.64). The brand lockup stays: it says which app is asking.
const HERO_COLLAPSE_FONT_SCALE = 1.5;

// signInMessage maps a failed hosted login to copy. Credentials are entered in
// Zitadel's own pages, so wrong-password and provider errors are shown there;
// what reaches the app is only whether the round trip completed.
export function signInMessage(err: unknown): string | null {
  if (err instanceof AuthSessionError) {
    if (err.code === "cancelled") return null;
    if (err.code === "access_denied") return "Sign-in was declined. Please try again.";
  }
  if (err instanceof TypeError) return "You appear to be offline. Check your connection and try again.";
  return "Something went wrong signing in. Please try again.";
}

export default function SignIn() {
  const { colors, spacing } = useTheme();
  // Reactive, so the screen relays out when the user changes their text size
  // and returns to a still-mounted app (kora#260's pattern).
  const { fontScale } = useWindowDimensions();
  const compactHero = fontScale > HERO_COLLAPSE_FONT_SCALE;
  // Set by api.ts's forced sign-out (a 401 that survived a token refresh) via
  // the redirect (tabs)/_layout.tsx makes; absent on a manual sign-out.
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const [error, setError] = useState<string | null>(() =>
    reason === "expired" ? "Your session expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

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

  async function start(register: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn({ register });
      router.replace("/");
    } catch (e: unknown) {
      setError(signInMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthScaffold
      footer={
        <AppText muted variant="footnote" style={{ textAlign: "center" }}>
          Email, Apple and Google sign-in all continue in a secure Tesserix page.
        </AppText>
      }
    >
      <BrandLockup />
      <AppText variant="title1" style={{ marginTop: compactHero ? 0 : spacing.sm }}>
        Welcome to Kora.
      </AppText>
      {compactHero ? null : (
        <AppText muted>Sign in to pick up where you left off, or create an account to start.</AppText>
      )}

      {/* Collapsible: minHeight lets it give way at large text sizes, and
          maxHeight (kora#172) stops taller devices pooling all their extra
          height into this one gap. */}
      <View
        style={{
          flex: 1,
          minHeight: compactHero ? 0 : spacing.xl,
          maxHeight: SIGN_IN_TOP_GAP_MAX,
        }}
      />

      {/* flexShrink: 0 is load-bearing (kora#173): without it the scaffold's
          flexGrow clamps content to the viewport at accessibility sizes and
          the last button is clipped rather than scrollable. */}
      <View style={{ gap: spacing.sm, flexShrink: 0 }}>
        <Button
          testID="sign-in-continue"
          accessibilityLabel="Continue"
          title={busy ? "…" : "Continue"}
          icon="arrow-right"
          iconPosition="trailing"
          disabled={busy}
          onPress={() => void start(false)}
        />
        <Button
          testID="sign-in-create"
          accessibilityLabel="Create account"
          title="Create account"
          variant="secondary"
          disabled={busy}
          onPress={() => void start(true)}
          style={{
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            opacity: busy ? 0.6 : 1,
            minHeight: 48,
          }}
        />
      </View>

      {error ? (
        <AppText variant="footnote" accessibilityLiveRegion="polite" style={{ color: colors.destructive }}>
          {error}
        </AppText>
      ) : null}

      {/* With the spacer above, this 2:1 split lands the buttons around
          55-60% of the screen: low enough for the thumb, not centred. */}
      <View style={{ flex: 0.5, minHeight: spacing.md }} />
    </AuthScaffold>
  );
}
