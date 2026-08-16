import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { unregisterPushToken } from "@/lib/push";
import { cancelAllReminders } from "@/reminders/schedule";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { AppText } from "@/components/Text";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/Badge";
import { PressableScale, ScreenEntrance } from "@/motion";
import { useProfile, useUnreadCount } from "@/api/hooks";
import { useTheme } from "@/theme";

// More tab, restyled to the Instrument Glass language (spec:
// docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md). Rows
// are composed inline rather than through GroupedList's Row/GroupedSection —
// that was true when More alone was in scope; the More-subscreens uplift
// (docs/superpowers/sdd/2026-08-11-kora-instrument-glass/) later restyled
// GroupedList itself to these same Instrument Glass tokens, so this file's
// bespoke MoreRow/MoreGroup and GroupedList's Row/GroupedSection now render
// near-identically — MoreRow is kept as-is rather than migrated to avoid
// churn on an already-shipped screen. The unread-count Badge is the one
// accent element this screen is allowed.
type MoreRowKey = "profile" | "friends" | "groups" | "notifications" | "recipes" | "settings" | "feedback" | "about";

type MoreRowProps = {
  rowKey: MoreRowKey;
  title: string;
  icon: string;
  right?: ReactNode;
  onPress: () => void;
};

function MoreRow({ rowKey, title, icon, right, onPress }: MoreRowProps) {
  const { instrument, spacing } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={title}
      haptic="none"
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md }}
    >
      <View
        testID={`more-icon-${rowKey}`}
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          backgroundColor: instrument.inset,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: instrument.glassBorder,
          alignItems: "center",
          justifyContent: "center",
          marginRight: spacing.sm,
          overflow: "hidden",
        }}
      >
        {/* wellShadow top inner line (spec: "icon wells get a wellShadow top
            line") — same recessed-well cue BezelCluster's WellFooter gives
            its own inset strip. */}
        <View
          testID={`more-icon-${rowKey}-well-shadow`}
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 1, backgroundColor: instrument.wellShadow }}
        />
        <Icon name={icon} size={17} color={instrument.mut} />
      </View>
      <AppText style={{ flex: 1, fontSize: 15, fontWeight: "500", color: instrument.ink }}>{title}</AppText>
      {right}
      <Icon name="chevron-right" size={14} color={instrument.mut} />
    </PressableScale>
  );
}

// Falls back to "K" when the name is empty/whitespace-only — same fallback
// as app/profile.tsx's own `initials` and app/(tabs)/index.tsx's.
function initials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "K";
  return parts
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function MoreGroup({ children }: { children: ReactNode }) {
  const { instrument, spacing } = useTheme();
  const rows = Array.isArray(children) ? children.filter(Boolean) : [children];
  return (
    <GlassPanel radius={22}>
      {rows.map((row, index) => (
        <View key={index}>
          {row}
          {index < rows.length - 1 ? (
            <View
              style={{
                marginLeft: spacing.md + 34 + spacing.sm,
                height: StyleSheet.hairlineWidth,
                backgroundColor: instrument.hairline,
              }}
            />
          ) : null}
        </View>
      ))}
    </GlassPanel>
  );
}

export default function More() {
  const { spacing, instrument } = useTheme();
  const insets = useSafeAreaInsets();
  const unread = useUnreadCount();
  const count = unread.data?.count ?? 0;
  const profile = useProfile();
  const data = profile.data;

  return (
    <ScreenEntrance direction={3}>
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Your account" title="More" />
      <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
        {/* More's one BezelCluster hero (spec: "Identity hero → BezelCluster")
            — the screen's one accent is a whisper glow behind the avatar
            well, not a full-panel glow, so `glow` is left off the cluster
            itself and applied directly to the Avatar's wrapping well below. */}
        <BezelCluster radius={25} testID="more-identity-hero">
          <View style={{ alignItems: "center", paddingVertical: spacing.lg }}>
            <View
              style={{
                borderRadius: 999,
                shadowColor: instrument.accent,
                shadowOpacity: 0.35,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: 0 },
              }}
            >
              <Avatar initials={data ? initials(data.display_name) : "—"} size={72} />
            </View>
            <AppText style={{ fontSize: 20, fontWeight: "700", color: instrument.ink, marginTop: spacing.sm }}>
              {data ? data.display_name : "Loading…"}
            </AppText>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: spacing.xs / 2 }}>
              {data ? data.email : "—"}
            </AppText>
          </View>
        </BezelCluster>
        <MoreGroup>
          <MoreRow
            rowKey="profile"
            title="Profile"
            icon="person"
            onPress={() => router.push("/profile" as Href)}
          />
          <MoreRow
            rowKey="friends"
            title="Friends"
            icon="users"
            onPress={() => router.push("/friends" as Href)}
          />
          <MoreRow
            rowKey="groups"
            title="Groups"
            icon="people"
            onPress={() => router.push("/groups" as Href)}
          />
          <MoreRow
            rowKey="notifications"
            title="Notifications"
            icon="bell"
            right={count > 0 ? (
              <View style={{ marginRight: spacing.xs }}>
                <Badge variant="instrument">{count}</Badge>
              </View>
            ) : null}
            onPress={() => router.push("/notifications" as Href)}
          />
          <MoreRow
            rowKey="recipes"
            title="Recipes"
            icon="book-open"
            onPress={() => router.push("/recipes" as Href)}
          />
        </MoreGroup>
        <MoreGroup>
          <MoreRow
            rowKey="settings"
            title="Settings"
            icon="gear"
            onPress={() => router.push("/settings" as Href)}
          />
          <MoreRow
            rowKey="feedback"
            title="Send feedback"
            icon="message-circle"
            onPress={() => router.push("/feedback" as Href)}
          />
          {/* Not decoration: Open Food Facts data is published under ODbL,
              which obliges Kora to attribute it wherever the data is used.
              This row is the route to that attribution (kora#197). */}
          <MoreRow
            rowKey="about"
            title="About"
            icon="book-open"
            onPress={() => router.push("/about" as Href)}
          />
        </MoreGroup>
        <GlassPanel radius={22}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            haptic="none"
            style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md }}
            onPress={async () => {
              if (!auth) return;
              try {
                await unregisterPushToken();
              } catch {
                // best-effort: still sign out even if de-registration fails
              }
              // The LOCAL counterpart to the de-registration above. Meal,
              // custom and weight reminders are scheduled in the OS, not on
              // the server, so unregistering the device leaves every one of
              // them armed — on a shared device they then fire at the previous
              // user's mealtimes (#171). Best-effort for the same reason.
              try {
                await cancelAllReminders();
              } catch {
                // best-effort: never trap the user in a session they left
              }
              await signOut(auth);
            }}
          >
            <AppText style={{ flex: 1, fontSize: 15, fontWeight: "500", color: instrument.danger }}>
              Sign out
            </AppText>
          </PressableScale>
        </GlassPanel>
      </View>
      </ScrollView>
    </View>
    </ScreenEntrance>
  );
}
