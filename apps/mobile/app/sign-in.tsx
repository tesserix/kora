import { useEffect, useState } from "react";
import { KeyboardAvoidingView, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  type AuthCredential,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { clearSnapshot } from "../modules/widget-bridge";
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

// Ceiling for the collapsible gap between the lockup and the provider buttons
// (kora#172). Not a spacing token on purpose: this is not a rhythm value to be
// picked from a scale, it is the measured height that gap settles at on the
// narrowest device we support, captured so that taller screens stop inflating
// it. Raising it re-opens the bug; lowering it pulls the button cluster up on
// every device, which is a design change rather than a fix.
const SIGN_IN_TOP_GAP_MAX = 248;

export default function SignIn() {
  // The `!isFirebaseConfigured` guard USED to sit here, above every hook below
  // — a conditional-hooks violation (#159). It never crashed, because
  // isFirebaseConfigured is `config !== null` evaluated once at module scope,
  // so the hook order was stable by accident rather than by construction. The
  // moment that value became anything computed per render, every hook below it
  // would shift index. The guard now sits after the last hook instead; nothing
  // between here and there has a side effect that matters in an unconfigured
  // build, and app/_layout.tsx redirects to /config-missing before this screen
  // mounts anyway. Pinned by sign-in-unconfigured.test.tsx.
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

  // Belt-and-braces: useWidgetSync clears the snapshot on sign-out, but that
  // relies on the tabs layout being mounted to observe the auth transition.
  // A dead-app auth drop or a swallowed Firebase signOut() never fires that
  // path, so the previous user's calories can persist in the widget past
  // sign-out. Landing here means whatever session existed is over one way or
  // another, so scrub on mount as a second, independent guarantee. Guarded
  // for module availability the same way modules/widget-bridge itself is
  // (absent on Android, absent in jest) — fire-and-forget, nothing here
  // should block or fail the sign-in screen.
  useEffect(() => {
    clearSnapshot();
  }, []);

  // Last hook is above; the guard is safe from here down.
  if (!isFirebaseConfigured) return null;

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
          // flexWrap so the two halves stack instead of running off the screen
          // (kora#173). A centred row with no wrap overflows BOTH edges once the
          // text outgrows the width, which at accessibility text sizes put
          // "Create an account" -- the only way to reach signup -- partly past
          // the right edge.
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "center",
              gap: 6,
            }}
          >
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
            (the form, the keyboard) needs the room.

            maxHeight is the kora#172 half. Without a ceiling this spacer takes
            two thirds of every extra point a taller device offers (flex 1 here
            against flex 0.5 below), so the surplus pools into one dead band
            instead of the layout breathing. Measured on the sign-in screen:
            going 17 Pro -> 17 Pro Max adds 82pt of height, of which 54.7pt --
            67%, exactly the 2:1 flex split -- landed in this single gap, while
            content grew 16.7pt. The cap is the gap this spacer already settles
            at on the smaller device, so that layout is unchanged and larger
            screens stop inflating it; what is left flows to the spacer below
            the buttons, lifting the cluster rather than stretching the void. */}
        <View style={{ flex: 1, minHeight: spacing.xl, maxHeight: SIGN_IN_TOP_GAP_MAX }} />

        {/* flexShrink: 0 is load-bearing (kora#173). The scaffold's ScrollView
            sets contentContainerStyle.flexGrow = 1, and the spacers around this
            block are `flex`, which means flexShrink: 1. At accessibility text
            sizes the buttons grow past the viewport, the flexible children
            absorb the difference, and the content ends up clamped to EXACTLY
            the viewport height -- so the ScrollView has no overflow to scroll
            and simply clips the last button. Verified on device: two
            screenshots either side of a swipe were byte-identical, with
            "Continue with email" cut through the middle of the word and no way
            to reach it. Refusing to shrink lets the content exceed the viewport,
            which is what turns the scaffold's ScrollView back into a scroll
            view. */}
        <View style={{ gap: spacing.sm, flexShrink: 0 }}>
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

        {/* Paired with the flex:1 spacer above, this 2:1 split lands the action
            cluster around 55-60% of the screen — low enough for the thumb,
            asymmetric rather than centred. Without a flex here the upper spacer
            takes ALL the slack and bottom-anchors the cluster against the
            footer rule, which is what shipped and read as unbalanced.

            The floor tightens once the form is revealed, so the slack the
            keyboard forces out goes to the form rather than to dead space
            below the submit. */}
        <View style={{ flex: 0.5, minHeight: showEmail ? spacing.sm : spacing.md }} />

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
