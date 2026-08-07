import { useEffect, useState } from "react";
import { Modal, Platform, TextInput, View } from "react-native";
import type { AuthCredential } from "firebase/auth";
import {
  completeLinkWithApple,
  completeLinkWithGoogle,
  completeLinkWithPassword,
  existingSignInMethods,
} from "@/auth/link";
import type { AuthErrorContext } from "@/auth/errors";
import { firebaseAuthMessage } from "@/lib/firebaseAuthMessage";
import {
  configureGoogleSignin,
  signInWithAppleNative,
  signInWithGoogleNative,
} from "@/lib/socialAuth";
import { storeAppleAuthorization } from "@/api/hooks";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

export interface LinkAccountPromptProps {
  visible: boolean;
  email: string;
  provider: "google.com" | "apple.com";
  pendingCredential: AuthCredential;
  onCancel: () => void;
  onLinked: () => void;
}

const PROVIDER_LABEL: Record<LinkAccountPromptProps["provider"], string> = {
  "google.com": "Google",
  "apple.com": "Apple",
};

export function LinkAccountPrompt({
  visible,
  email,
  provider,
  pendingCredential,
  onCancel,
  onLinked,
}: LinkAccountPromptProps) {
  const { colors, spacing, fontSize } = useTheme();
  const [methods, setMethods] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await existingSignInMethods(email);
      if (!cancelled) setMethods(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  const passwordMatches = methods?.includes("password") ?? false;
  const googleMatches = methods?.includes("google.com") ?? false;
  const appleMatches = methods?.includes("apple.com") ?? false;
  // `unknown` covers every case where nothing above would render a control:
  // enumeration protection ([]), an unrecognised method list, and the case where
  // the only match is the provider being linked (which can never be its own
  // re-auth option). Fail OPEN in all of them, so the sheet never dead-ends
  // with just Cancel.
  const anyControlWouldRender =
    passwordMatches ||
    (provider !== "google.com" && googleMatches) ||
    (provider !== "apple.com" && appleMatches);
  const unknown = methods !== null && !anyControlWouldRender;
  const showPassword = methods === null || unknown || passwordMatches;
  const showGoogle = provider !== "google.com" && (unknown || googleMatches);
  // Apple's native sheet does not exist on Android — without this guard, the
  // fail-open path above (`unknown === true` under email-enumeration
  // protection) offers "Continue with Apple to link" on Android routinely,
  // and tapping it calls an API that isn't there.
  const showApple = Platform.OS === "ios" && provider !== "apple.com" && (unknown || appleMatches);

  async function run(fn: () => Promise<void>, ctx?: AuthErrorContext) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
      onLinked();
    } catch (e: unknown) {
      // null means the user cancelled — render nothing.
      setError(firebaseAuthMessage(e, ctx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        <Card variant="elevated" style={{ padding: spacing.lg, gap: spacing.sm }}>
          <AppText variant="title2">Link your account</AppText>
          <AppText muted>
            An account already exists for {email}. Sign in to connect {PROVIDER_LABEL[provider]}.
          </AppText>

          {showPassword ? (
            <View style={{ gap: spacing.sm }}>
              <Card variant="elevated" style={{ padding: 0 }}>
                <TextInput
                  accessibilityLabel="Password"
                  style={{
                    paddingHorizontal: spacing.md,
                    paddingVertical: 12,
                    color: colors.label,
                    fontSize: fontSize.base,
                    minHeight: 48,
                  }}
                  placeholder="Password"
                  placeholderTextColor={colors.secondaryLabel}
                  secureTextEntry
                  autoComplete="password"
                  textContentType="password"
                  value={password}
                  onChangeText={setPassword}
                />
              </Card>
              <Button
                accessibilityLabel="Sign in and link"
                title={busy ? "Linking…" : "Sign in and link"}
                disabled={busy}
                onPress={() =>
                  void run(() => completeLinkWithPassword(email, password, pendingCredential), {
                    method: "password",
                  })
                }
              />
            </View>
          ) : null}

          {showGoogle ? (
            <Button
              accessibilityLabel="Continue with Google to link"
              title="Continue with Google to link"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    configureGoogleSignin();
                    const idToken = await signInWithGoogleNative();
                    await completeLinkWithGoogle(idToken, pendingCredential);
                  },
                  { method: "social", provider: "google.com" },
                )
              }
            />
          ) : null}

          {showApple ? (
            <Button
              accessibilityLabel="Continue with Apple to link"
              title="Continue with Apple to link"
              variant="secondary"
              disabled={busy}
              onPress={() =>
                void run(
                  async () => {
                    const { idToken, rawNonce, authorizationCode } = await signInWithAppleNative();
                    await completeLinkWithApple(idToken, rawNonce, pendingCredential);
                    // Non-fatal, same reasoning as the sign-in path
                    // (socialCredentials.ts): a failed capture must never
                    // undo a link that already succeeded. Without this call,
                    // this fresh code — the only one this flow will ever see
                    // — is fetched from Apple and discarded, leaving the user
                    // unrevokable until their next Apple sign-in.
                    if (authorizationCode) {
                      try {
                        await storeAppleAuthorization(authorizationCode);
                      } catch {
                        // Swallowed deliberately; the link itself already succeeded.
                      }
                    }
                  },
                  { method: "social", provider: "apple.com" },
                )
              }
            />
          ) : null}

          {error ? (
            <AppText
              variant="footnote"
              accessibilityLiveRegion="polite"
              style={{ color: colors.destructive }}
            >
              {error}
            </AppText>
          ) : null}

          <Button accessibilityLabel="Cancel" title="Cancel" variant="ghost" disabled={busy} onPress={onCancel} />
        </Card>
      </View>
    </Modal>
  );
}
