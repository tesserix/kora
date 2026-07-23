import { useState } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from "firebase/auth";
import { auth } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { useTheme } from "@/theme";

export default function SignIn() {
  const { colors, spacing, radius } = useTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: radius.lg,
    padding: spacing.md,
    color: colors.foreground,
    minHeight: 48,
  } as const;

  async function submit(mode: "in" | "up") {
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
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Welcome to Kora</AppText>
      <TextInput style={inputStyle} placeholder="Email" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <TextInput style={inputStyle} placeholder="Password" placeholderTextColor={colors.mutedForeground} secureTextEntry value={password} onChangeText={setPassword} />
      {error ? <AppText style={{ color: colors.destructive }}>{error}</AppText> : null}
      <Button title={busy ? "…" : "Sign in"} onPress={() => submit("in")} disabled={busy} />
      <Button title="Create account" variant="secondary" onPress={() => submit("up")} disabled={busy} />
    </View>
  );
}
