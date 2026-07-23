import { useEffect, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { apiFetch } from "@/lib/api";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { useTheme } from "@/theme";

type Profile = { email: string; display_name: string };

export default function Index() {
  if (!isFirebaseConfigured) return null;

  const { colors, spacing } = useTheme();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/sign-in");
        return;
      }
      try {
        setProfile((await apiFetch("/v1/me")) as Profile);
      } catch {
        setError("Could not load your profile.");
      }
    });
    return unsub;
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center", padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Kora</AppText>
      <Card>
        <AppText variant="h3">Profile</AppText>
        <AppText muted>{error ?? profile?.email ?? "Loading…"}</AppText>
      </Card>
      <Button title="Sign out" variant="ghost" onPress={() => auth && signOut(auth)} />
    </View>
  );
}
