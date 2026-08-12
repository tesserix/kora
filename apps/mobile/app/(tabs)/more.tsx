import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";
import { signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { unregisterPushToken } from "@/lib/push";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { AppText } from "@/components/Text";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/Badge";
import { PressableScale } from "@/motion";
import { useUnreadCount } from "@/api/hooks";
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
type MoreRowKey = "profile" | "friends" | "groups" | "notifications" | "recipes" | "settings" | "feedback";

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
        }}
      >
        <Icon name={icon} size={17} color={instrument.mut} />
      </View>
      <AppText style={{ flex: 1, fontSize: 15, fontWeight: "500", color: instrument.ink }}>{title}</AppText>
      {right}
      <Icon name="chevron-right" size={14} color={instrument.mut} />
    </PressableScale>
  );
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

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
      <ScreenHeader overline="Your account" title="More" />
      <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
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
  );
}
