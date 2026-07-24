import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { Overline } from "@/components/Overline";
import { CaptureHero } from "@/components/home/CaptureHero";
import { FuelStrip } from "@/components/home/FuelStrip";
import { FeedMeal } from "@/components/home/FeedMeal";
import { useProfile, useDashboard, useDayLogs } from "@/api/hooks";
import { useTheme } from "@/theme";
import type { FoodLog } from "@/api/types";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
function dateLabel(): string {
  return new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function initials(name?: string): string {
  if (!name) return "K";
  return name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

// Static Otto notes — placeholder until Phase 6 coaching.
const NOTES: Array<string | null> = ["Solid protein start — kept you full till noon.", null, "Smart snack choice.", null];

export default function Home() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const date = today();
  const dashboard = useDashboard(date);
  const logs = useDayLogs(date);

  const d = dashboard.data;
  const loadError = dashboard.isError || logs.isError;
  const eaten = d?.consumed.kcal ?? 0;
  const goal = d?.targets.kcal ?? 0;
  const left = Math.round(Math.max(0, goal - eaten));
  const loggedMeals = (logs.data ?? []) as FoodLog[];

  const openMeal = (log: FoodLog) =>
    router.push({
      pathname: "/meal",
      params: { name: log.description, mealSlot: log.meal_slot, time: new Date(log.logged_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), kcal: String(Math.round(log.kcal)), protein: String(Math.round(log.protein_g)), carbs: String(Math.round(log.carbs_g)), fat: String(Math.round(log.fat_g)) },
    });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingBottom: 130 }}>
      {/* header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingBottom: 16 }}>
        <View>
          <Overline>{dateLabel()}</Overline>
          <AppText style={{ fontSize: 15, fontWeight: "600" }}>{greeting()}, {profile.data?.display_name?.split(" ")[0] ?? "there"}</AppText>
        </View>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open coach"
            onPress={() => {}}
            style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="message-circle" size={19} color={colors.foreground} />
          </Pressable>
          <Avatar initials={initials(profile.data?.display_name)} />
        </View>
      </View>

      {/* Otto editorial headline (static copy placeholder) */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 18 }}>
        {loadError ? (
          <AppText style={{ color: colors.destructive, fontSize: 15, lineHeight: 22 }}>
            Couldn't load your day. Pull to refresh or try again.
          </AppText>
        ) : d ? (
          <>
            <AppText style={{ fontSize: 27, lineHeight: 32, fontWeight: "800", letterSpacing: -0.81 }}>
              You're <AppText style={{ fontSize: 27, lineHeight: 32, fontWeight: "800", letterSpacing: -0.81, color: colors.primary }}>{left.toLocaleString()} kcal</AppText> from a strong day.
            </AppText>
            <AppText muted style={{ marginTop: 8, fontSize: 14.5, lineHeight: 22 }}>Protein's on track. A lean, high-protein dinner and you'll close every ring.</AppText>
          </>
        ) : (
          <AppText muted style={{ fontSize: 15, lineHeight: 22 }}>Getting your day ready…</AppText>
        )}
      </View>

      {/* Capture hero */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 18 }}>
        <CaptureHero onPress={() => router.push("/log")} />
      </View>

      {/* Compact fuel summary */}
      {d ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
          <FuelStrip
            eaten={eaten}
            goal={goal}
            macros={{ p: d.consumed.protein_g, c: d.consumed.carbs_g, f: d.consumed.fat_g, pGoal: d.targets.protein_g, cGoal: d.targets.carbs_g, fGoal: d.targets.fat_g }}
          />
        </View>
      ) : null}

      {/* Today feed */}
      <View style={{ paddingHorizontal: 20 }}>
        <Overline style={{ fontSize: 13, letterSpacing: 1 }}>Today</Overline>
        <View style={{ gap: 14, marginTop: 12 }}>
          {loggedMeals.map((log, i) => (
            <FeedMeal key={log.id} log={log} note={NOTES[i % NOTES.length]} onOpen={() => openMeal(log)} />
          ))}
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderRadius: 16, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.border }}
          >
            <Icon name="plus" size={20} color={colors.primary} />
            <AppText style={{ fontSize: 14, fontWeight: "600" }}>Add a meal</AppText>
            <AppText muted style={{ marginLeft: "auto", fontSize: 12 }}>Snap · say · scan</AppText>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}
