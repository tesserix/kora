import { useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";

import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { SocialAudit } from "@/components/social/SocialAudit";
import { AddFriendSheet } from "@/components/social/AddFriendSheet";
import { CreateGroupSheet } from "@/components/social/CreateGroupSheet";
import { PressableScale } from "@/motion";
import { useCircles, useFriends, useFriendRequests, useGroups, useAcceptRequest, useDeclineRequest } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { initials } from "@/lib/initials";
import { useTheme } from "@/theme";

import type { Friend, FriendRequest, GroupSummary } from "@/api/types";

// Social: one destination for the three More rows that used to be Friends,
// Sharing and Groups (kora#444).
//
// The audit is the hero and sits FIRST. Sharing is a privacy control, and the
// obvious consolidation — a segmented control — would have buried a
// data-sharing setting one level deeper. Heading the screen with "who can see
// your data" makes it more discoverable than the row it replaces, which is the
// whole justification for the merge.
//
// This screen is a switchboard, not a workspace: two primary actions (add a
// friend, new group) and previews that hand off to the full screens. Circle
// management, member removal and group actions all stay where they live.

const FRIEND_PREVIEW = 5;
const GROUP_PREVIEW = 4;
const REQUEST_PREVIEW = 2;

// kora#452: at accessibility text sizes a [avatar · name · trailing control]
// row breaks because the name is squeezed between two fixed-size siblings —
// the request row's pair of 44pt accept/decline buttons is the worst of the
// three, but every row here shares the shape. Past this scale the trailing
// control drops to its own line under the name instead of sharing one with
// it, so the name gets (almost) the full row width to wrap into rather than
// a shrinking sliver.
//
// Same boundary and same reasoning as sign-in.tsx's HERO_COLLAPSE_FONT_SCALE
// (kora#173/#260): 1.5 sits between iOS's largest non-accessibility size
// (xxxL, ~1.35) and its smallest accessibility one (AX1, ~1.64), so every
// non-accessibility user's layout is untouched. `useWindowDimensions`, not
// `PixelRatio.getFontScale()` — the former is reactive, so the screen relays
// out when the user changes text size and returns to a still-mounted app.
const ROW_STACK_FONT_SCALE = 1.5;

function useStackedRows(): boolean {
  const { fontScale } = useWindowDimensions();
  return fontScale > ROW_STACK_FONT_SCALE;
}

// kora#449 task 15 finding 3, mirroring LookupResultCard.tsx's fallback
// (kora#443): a blank display_name must never render as an empty line or an
// accessibility label with nothing after it. "@handle" is a true statement
// about this person; blank is not.
function displayName(person: Friend): string {
  return person.display_name.trim() || "@" + person.handle;
}

function Engraved({ children }: { children: string }) {
  const { instrument } = useTheme();
  return (
    <AppText
      maxFontSizeMultiplier={1.4}
      style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
    >
      {children}
    </AppText>
  );
}

// A dashed ghost row. Every section's primary action uses one, so "the thing
// that adds something" looks the same everywhere on this screen.
function GhostCta({ label, onPress }: { label: string; onPress: () => void }) {
  const { instrument, spacing, radius } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      haptic="selection"
      onPress={onPress}
      style={{
        borderRadius: radius?.md ?? 18,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: instrument.glassBorder,
        paddingVertical: spacing.md,
        alignItems: "center",
      }}
    >
      <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.mut }}>{label}</AppText>
    </PressableScale>
  );
}

function Hairline() {
  const { instrument } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />;
}

function OverflowRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { instrument, spacing } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      haptic="none"
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.sm }}
    >
      <AppText style={{ flex: 1, fontSize: 15, color: instrument.mut }}>{label}</AppText>
      <Icon name="chevron-right" size={14} color={instrument.mut} />
    </PressableScale>
  );
}

// Tapping a friend opens their body metrics if they share them, and one calm
// "nothing shared with you" state otherwise (kora#441). These rows were inert
// before; this gives them the purpose they were missing, one tap from the
// audit that grants the same category in the other direction.
function PersonRow({ friend }: { friend: Friend }) {
  const { instrument, spacing } = useTheme();
  const stacked = useStackedRows();
  const name = displayName(friend);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      haptic="none"
      onPress={() => router.push(`/friend/${friend.id}` as Href)}
      style={{ minHeight: 44, paddingVertical: spacing.xs, gap: spacing.xs }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Avatar initials={initials(friend.display_name)} uri={friend.avatar_url} size={30} />
        <AppText style={{ flex: 1, fontSize: 15, color: instrument.ink }}>{name}</AppText>
        {stacked ? null : <Icon name="chevron-right" size={14} color={instrument.mut} />}
      </View>
      {/* Past the reflow threshold the chevron drops to its own line, right
          aligned, so it never shares row width with the name (kora#452). */}
      {stacked ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Icon name="chevron-right" size={14} color={instrument.mut} />
        </View>
      ) : null}
    </PressableScale>
  );
}

function GroupRow({ group }: { group: GroupSummary }) {
  const { instrument, spacing } = useTheme();
  const stacked = useStackedRows();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open group ${group.name}`}
      haptic="none"
      onPress={() => router.push(`/group/${group.id}` as Href)}
      style={{ minHeight: 44, paddingVertical: spacing.sm, gap: spacing.xs }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>{group.name}</AppText>
          <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: 1 }}>
            {`${group.member_count} ${group.member_count === 1 ? "member" : "members"}${group.role === "owner" ? " · Owner" : ""}`}
          </AppText>
        </View>
        {stacked ? null : <Icon name="chevron-right" size={14} color={instrument.mut} />}
      </View>
      {stacked ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Icon name="chevron-right" size={14} color={instrument.mut} />
        </View>
      ) : null}
    </PressableScale>
  );
}

// This is the screen where consent is granted — the face is the whole point
// of being able to tell who is asking before accepting (kora#454). At the
// reflow threshold the accept/decline pair (44pt targets each, kora#446) drop
// to their own row instead of sharing one with the name: two 44pt buttons is
// 88pt of fixed width plus gaps, and that is exactly the sibling that was
// squeezing the name to nothing (kora#452).
function RequestRow({
  request,
  onAccept,
  onDecline,
}: {
  request: FriendRequest;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { instrument, spacing } = useTheme();
  const stacked = useStackedRows();
  const name = displayName(request.user);
  const controls = (
    <>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Accept request from ${name}`}
        haptic="selection"
        onPress={onAccept}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="check" size={18} color={instrument.accent} />
      </PressableScale>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Decline request from ${name}`}
        haptic="selection"
        onPress={onDecline}
        style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="x" size={18} color={instrument.mut} />
      </PressableScale>
    </>
  );
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.xs, gap: spacing.sm }}>
        <Avatar initials={initials(request.user.display_name)} uri={request.user.avatar_url} size={30} />
        <AppText style={{ flex: 1, fontSize: 15, color: instrument.ink }}>{name}</AppText>
        {stacked ? null : controls}
      </View>
      {stacked ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm }}>{controls}</View>
      ) : null}
    </View>
  );
}

export default function Social() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const circlesQuery = useCircles();
  const friendsQuery = useFriends();
  const requestsQuery = useFriendRequests();
  const groupsQuery = useGroups();
  const accept = useAcceptRequest();
  const decline = useDeclineRequest();

  const [addFriendOpen, setAddFriendOpen] = useState(false);
  const [groupMode, setGroupMode] = useState<"create" | "join" | null>(null);

  const surfaceError = { onError: (error: unknown) => toast.show({ message: apiErrorMessage(error) }) };

  const circles = circlesQuery.data ?? [];
  const friends = friendsQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const incoming = requestsQuery.data?.incoming ?? [];

  // Every section renders from its OWN query state. One failed fetch must not
  // blank the other two, and — the case that actually matters — a failed
  // circles fetch must never let the audit render as "nobody can see your
  // data", which is a dangerously reassuring thing to say when the truth is
  // that we could not ask (#174).
  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Who can see your data" title="Social" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          <SocialAudit
            circles={circles}
            failed={circlesQuery.isError}
            onRetry={() => circlesQuery.refetch?.()}
          />

          {/* Friends */}
          <View style={{ gap: spacing.xs }}>
            <Engraved>
              {incoming.length > 0
                ? `Friends · ${incoming.length} ${incoming.length === 1 ? "request" : "requests"}`
                : "Friends"}
            </Engraved>
            <GhostCta label="Add a friend" onPress={() => setAddFriendOpen(true)} />
            {friendsQuery.isError ? (
              <LoadErrorNotice
                testID="friends-load-error"
                message="Couldn't load your friends."
                onRetry={() => friendsQuery.refetch?.()}
              />
            ) : (
              <GlassPanel radius={22}>
                <View style={{ paddingHorizontal: spacing.md }}>
                  {/* 44pt targets. The equivalent controls on the standalone
                      Friends screen are 32pt, below the floor — not carried
                      over here. */}
                  {incoming.slice(0, REQUEST_PREVIEW).map((req) => (
                    <View key={req.id}>
                      <RequestRow
                        request={req}
                        onAccept={() => accept.mutate(req.id, surfaceError)}
                        onDecline={() => decline.mutate(req.id, surfaceError)}
                      />
                      <Hairline />
                    </View>
                  ))}
                  {incoming.length > REQUEST_PREVIEW ? (
                    <OverflowRow
                      label={`+${incoming.length - REQUEST_PREVIEW} more requests`}
                      onPress={() => router.push("/friends" as Href)}
                    />
                  ) : null}

                  {friends.length === 0 ? (
                    <EmptyState
                      title="No friends yet"
                      subtitle="Add someone by their handle, email or friend code."
                    />
                  ) : (
                    friends.slice(0, FRIEND_PREVIEW).map((friend, index) => (
                      <View key={friend.id}>
                        {index > 0 ? <Hairline /> : null}
                        <PersonRow friend={friend} />
                      </View>
                    ))
                  )}
                  {friends.length > FRIEND_PREVIEW ? (
                    <>
                      <Hairline />
                      <OverflowRow
                        label={`See all ${friends.length} friends`}
                        onPress={() => router.push("/friends" as Href)}
                      />
                    </>
                  ) : null}
                </View>
              </GlassPanel>
            )}
          </View>

          {/* Groups */}
          <View style={{ gap: spacing.xs }}>
            <Engraved>Groups</Engraved>
            <GhostCta label="New group" onPress={() => setGroupMode("create")} />
            {groupsQuery.isError ? (
              <LoadErrorNotice
                testID="groups-load-error"
                message="Couldn't load your groups."
                onRetry={() => groupsQuery.refetch?.()}
              />
            ) : (
              <GlassPanel radius={22}>
                <View style={{ paddingHorizontal: spacing.md }}>
                  {groups.length === 0 ? (
                    <EmptyState title="No groups yet" subtitle="Create one, or join with a code." />
                  ) : (
                    groups.slice(0, GROUP_PREVIEW).map((group, index) => (
                      <View key={group.id}>
                        {index > 0 ? <Hairline /> : null}
                        <GroupRow group={group} />
                      </View>
                    ))
                  )}
                  {groups.length > GROUP_PREVIEW ? (
                    <>
                      <Hairline />
                      <OverflowRow
                        label={`See all ${groups.length} groups`}
                        onPress={() => router.push("/groups" as Href)}
                      />
                    </>
                  ) : null}
                </View>
              </GlassPanel>
            )}
          </View>
        </View>
      </ScrollView>

      <AddFriendSheet visible={addFriendOpen} onClose={() => setAddFriendOpen(false)} />
      {groupMode ? (
        <CreateGroupSheet visible mode={groupMode} onClose={() => setGroupMode(null)} />
      ) : null}
    </View>
  );
}
