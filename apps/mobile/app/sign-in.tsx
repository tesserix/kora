import { useState } from "react";
import { KeyboardAvoidingView, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Overline } from "@/components/Overline";
import { AppBackground } from "@/components/AppBackground";
import { useTheme } from "@/theme";

export default function SignIn() {
  if (!isFirebaseConfigured) return null;

  const { colors, spacing, fontSize } = useTheme();
  // Set by api.ts's forced sign-out (a 401 that survived a token refresh)
  // via the redirect (tabs)/_layout.tsx makes when the session becomes
  // unusable — not present on a manual sign-out.
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() =>
    reason === "expired" ? "Your session expired. Please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

  const filledInputStyle = {
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.label,
    fontSize: fontSize.base,
    minHeight: 48,
  } as const;

  async function submit(mode: "in" | "up") {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email, password);
      else await createUserWithEmailAndPassword(auth, email, password);
      router.replace("/");
    } catch {
      setError("Sign-in failed. Check your email and password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: "center", padding: spacing.lg, gap: spacing.lg }}>
          <View style={{ gap: spacing.xs }}>
            <Overline>Welcome back</Overline>
            <AppText variant="title1">Welcome to Kora</AppText>
          </View>
          <View style={{ gap: spacing.sm }}>
            <Card variant="elevated" style={{ padding: 0 }}>
              <TextInput
                accessibilityLabel="Email"
                style={filledInputStyle}
                placeholder="Email"
                placeholderTextColor={colors.secondaryLabel}
                autoCapitalize="none"
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
                value={password}
                onChangeText={setPassword}
              />
            </Card>
          </View>
          {error ? (
            <AppText variant="footnote" style={{ color: colors.destructive }}>
              {error}
            </AppText>
          ) : null}
          <View style={{ gap: spacing.sm }}>
            <Button title={busy ? "…" : "Sign in"} onPress={() => submit("in")} disabled={busy} />
            <Button title="Create account" variant="secondary" onPress={() => submit("up")} disabled={busy} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
