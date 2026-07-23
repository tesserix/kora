import { useEffect } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { AppText } from "@/components/Text";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Ring } from "@/components/Ring";
import { MacroBar } from "@/components/MacroBar";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { useAddWater, useDashboard, useDayLogs, useProfile } from "@/api/hooks";
import { useTheme } from "@/theme";

function today(): string {
  // Local calendar date (YYYY-MM-DD), not UTC — the backend buckets a day by the
  // user's timezone, so requesting the UTC date would show the wrong day in the
  // morning for AU users. en-CA formats as ISO in the device's local zone.
  return new Date().toLocaleDateString("en-CA");
}

export default function Index() {
  const { colors, spacing } = useTheme();
  const profile = useProfile();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);
  const addWater = useAddWater();

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      if (!user) router.replace("/sign-in");
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (profile.data && profile.data.onboarded_at === null) {
      router.replace("/onboarding");
    }
  }, [profile.data]);

  if (!isFirebaseConfigured) return null;

  const d = dashboard.data;
  const loadError = dashboard.isError || logs.isError || profile.isError;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <AppText variant="h1">Today</AppText>

      {d ? (
        <>
          <Card>
            <Ring value={d.consumed.kcal} max={d.targets.kcal} label="kcal" />
          </Card>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <MacroBar label="Protein" value={d.consumed.protein_g} target={d.targets.protein_g} color={colors.primary} />
              <MacroBar label="Carbs" value={d.consumed.carbs_g} target={d.targets.carbs_g} color={colors.accentForeground} />
              <MacroBar label="Fat" value={d.consumed.fat_g} target={d.targets.fat_g} color={colors.mutedForeground} />
            </View>
          </Card>
          <Card>
            <AppText variant="h3">Streak</AppText>
            <AppText muted>{d.streak_days} day{d.streak_days === 1 ? "" : "s"}</AppText>
          </Card>
          <Card>
            <AppText variant="h3">Water</AppText>
            <AppText muted>{d.water_ml} ml today</AppText>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm, flexWrap: "wrap" }}>
              {[250, 500, 750].map((ml) => (
                <Button key={ml} title={`+${ml}ml`} variant="secondary" onPress={() => addWater.mutate(ml)} />
              ))}
            </View>
          </Card>
        </>
      ) : loadError ? (
        <AppText style={{ color: colors.destructive }}>Couldn&apos;t load your day. Pull to refresh or try again.</AppText>
      ) : (
        <AppText muted>Loading your day…</AppText>
      )}

      <Button title="＋ Log food" onPress={() => router.push("/log")} />

      <AppText variant="h3">Logged today</AppText>
      {(logs.data ?? []).map((l) => (
        <Card key={l.id}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <AppText>{l.description}</AppText>
            <AppText muted>{Math.round(l.kcal)} kcal</AppText>
          </View>
          <View style={{ marginTop: spacing.xs }}>
            <ProvenanceChip provenance={l.provenance} />
          </View>
        </Card>
      ))}
      {(logs.data ?? []).length === 0 ? <AppText muted>Nothing logged yet.</AppText> : null}

      <Button title="Sign out" variant="ghost" onPress={() => auth && signOut(auth)} />
    </ScrollView>
  );
}
