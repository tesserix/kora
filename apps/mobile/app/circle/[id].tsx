import { useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, type Href } from "expo-router";

import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { ToggleSwitch } from "@/components/ToggleSwitch";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { PressableScale } from "@/motion";
import {
  useCircles,
  useFriends,
  useAddCircleMember,
  useRemoveCircleMember,
  useSetCircleCategories,
  useDeleteCircle,
} from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { categoryLabel, CATEGORY_ORDER } from "@/lib/shareAudit";
import { useTheme } from "@/theme";

import type { ShareCategory } from "@/api/types";

// One circle: who is in it, and what they can see (kora#437).
//
// The asymmetry between the two toggles is the whole point of this screen.
// `progress` is a plain switch; granting `body` shows the people it will
// expose BY NAME — the actual list, never "2 members" — and requires a
// confirm. Sharing a streak and sharing a body-fat percentage are different
// acts, and a UI that treats them identically is quietly wrong.
//
// Revoking is never gated. A permission surface that makes stopping harder
// than starting is working against the person it exists for.

// The categories endpoint is a PUT that REPLACES the whole set, so every
// toggle sends the full desired list rather than a delta. Derived in
// CATEGORY_ORDER so the request body is stable regardless of tap order.
function nextCategories(current: ShareCategory[], category: ShareCategory, on: boolean): ShareCategory[] {
  return CATEGORY_ORDER.filter((c) => (c === category ? on : current.includes(c)));
}

export default function CircleDetail() {
  const { instrument, spacing, radius, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const circlesQuery = useCircles();
  const friends = useFriends();
  const setCategories = useSetCircleCategories();
  const addMember = useAddCircleMember();
  const removeMember = useRemoveCircleMember();
  const deleteCircle = useDeleteCircle();
  const toast = useToast();

  const [adding, setAdding] = useState(false);
  const [confirmingBody, setConfirmingBody] = useState(false);

  const circle = (circlesQuery.data ?? []).find((c) => c.id === id);
  const surfaceError = { onError: (error: unknown) => toast.show({ message: apiErrorMessage(error) }) };

  if (circlesQuery.isError) {
    return (
      <Shell insets={insets.top} title="Circle">
        <LoadErrorNotice message="Couldn't load this circle." onRetry={() => circlesQuery.refetch?.()} />
      </Shell>
    );
  }

  // A circle another device deleted must read as gone, never as an empty
  // circle whose toggles still appear to work.
  if (!circle) {
    return (
      <Shell insets={insets.top} title="Circle">
        <EmptyState
          title="Circle not found"
          subtitle="It may have been deleted. Pull back to Sharing to see the ones you have."
        />
      </Shell>
    );
  }

  const memberNames = circle.members.map((m) => m.display_name).join(", ");
  const candidates = (friends.data ?? []).filter((f) => !circle.members.some((m) => m.id === f.id));

  const applyCategories = (category: ShareCategory, on: boolean) =>
    setCategories.mutate({ circleId: circle.id, categories: nextCategories(circle.categories, category, on) }, surfaceError);

  const onToggle = (category: ShareCategory, on: boolean) => {
    // Only GRANTING body is gated, and only when there is somebody to expose.
    // An empty circle exposes nobody, so there is nothing to picture — but the
    // grant is still recorded, or adding a member later would silently share
    // body metrics the owner never turned on.
    if (category === "body" && on && circle.members.length > 0) {
      setConfirmingBody(true);
      return;
    }
    applyCategories(category, on);
  };

  const onDelete = () =>
    Alert.alert("Delete circle?", `${circle.name} will stop sharing with everyone in it.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteCircle.mutate(circle.id, {
            onError: surfaceError.onError,
            onSuccess: () => safeBack("/sharing" as Href),
          }),
      },
    ]);

  return (
    <Shell insets={insets.top} title={circle.name} overline="Circle">
      <View style={{ gap: spacing.xs }}>
        <Engraved>Can see</Engraved>
        <GlassPanel radius={22}>
          <View style={{ paddingHorizontal: spacing.md }}>
            {CATEGORY_ORDER.map((category, index) => (
              <View key={category}>
                {index > 0 ? (
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                ) : null}
                <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.xs }}>
                  <View style={{ flex: 1 }}>
                    <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>
                      {categoryLabel(category)}
                    </AppText>
                    <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: 1 }}>
                      {category === "body" ? "Weight, measurements, body fat" : "Streak and how often you log"}
                    </AppText>
                  </View>
                  <ToggleSwitch
                    accessibilityLabel={`Share ${categoryLabel(category)}`}
                    value={circle.categories.includes(category)}
                    onValueChange={(on) => onToggle(category, on)}
                  />
                </View>
              </View>
            ))}
          </View>
        </GlassPanel>
      </View>

      {confirmingBody ? (
        <GlassPanel radius={18}>
          <View style={{ padding: spacing.md, gap: spacing.sm }}>
            <AppText style={{ fontSize: 15, fontWeight: "700", color: instrument.ink }}>
              Share your body metrics?
            </AppText>
            <AppText style={{ fontSize: 14, color: instrument.mut }}>
              These people will be able to see your weight, measurements and body fat:
            </AppText>
            {/* By name, as an actual list. "2 members" is exactly the
                abstraction that lets someone agree to something they have not
                pictured. */}
            <AppText testID="body-confirm-names" style={{ fontSize: 15, color: instrument.ink }}>
              {memberNames}
            </AppText>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing.md }}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Cancel sharing body metrics"
                haptic="selection"
                onPress={() => setConfirmingBody(false)}
              >
                <AppText style={{ fontSize: 15, color: instrument.mut }}>Cancel</AppText>
              </PressableScale>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Confirm sharing body metrics"
                haptic="selection"
                onPress={() => {
                  setConfirmingBody(false);
                  applyCategories("body", true);
                }}
              >
                <AppText style={{ fontSize: 15, fontWeight: "700", color: instrument.accent }}>Share</AppText>
              </PressableScale>
            </View>
          </View>
        </GlassPanel>
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <Engraved>{`${circle.members.length} ${circle.members.length === 1 ? "person" : "people"}`}</Engraved>
        <GlassPanel radius={22}>
          <View style={{ paddingHorizontal: spacing.md }}>
            {circle.members.length === 0 ? (
              <EmptyState title="Nobody yet" subtitle="Add a friend and they will see whatever this circle shares." />
            ) : (
              circle.members.map((member, index) => (
                <View key={member.id}>
                  {index > 0 ? (
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                  ) : null}
                  <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.xs }}>
                    <AppText style={{ flex: 1, fontSize: 15, color: instrument.ink }}>{member.display_name}</AppText>
                    <PressableScale
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${member.display_name} from ${circle.name}`}
                      haptic="selection"
                      onPress={() => removeMember.mutate({ circleId: circle.id, userId: member.id }, surfaceError)}
                    >
                      <Icon name="x" size={16} color={instrument.mut} />
                    </PressableScale>
                  </View>
                </View>
              ))
            )}
          </View>
        </GlassPanel>
      </View>

      {adding ? (
        <GlassPanel radius={18}>
          <View style={{ paddingHorizontal: spacing.md }}>
            {candidates.length === 0 ? (
              <EmptyState
                title="No one left to add"
                subtitle="Everyone you are friends with is already in this circle."
              />
            ) : (
              candidates.map((friend, index) => (
                <View key={friend.id}>
                  {index > 0 ? (
                    <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                  ) : null}
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${friend.display_name} to ${circle.name}`}
                    haptic="selection"
                    onPress={() => {
                      setAdding(false);
                      addMember.mutate({ circleId: circle.id, userId: friend.id }, surfaceError);
                    }}
                    style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.xs }}
                  >
                    <AppText style={{ flex: 1, fontSize: 15, color: instrument.ink }}>{friend.display_name}</AppText>
                    <Icon name="plus" size={16} color={instrument.mut} />
                  </PressableScale>
                </View>
              ))
            )}
          </View>
        </GlassPanel>
      ) : (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Add someone"
          haptic="selection"
          onPress={() => setAdding(true)}
          style={{
            borderRadius: radius?.md ?? 18,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: instrument.glassBorder,
            paddingVertical: spacing.md,
            alignItems: "center",
          }}
        >
          <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.mut }}>Add someone</AppText>
        </PressableScale>
      )}

      <GlassPanel radius={18}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Delete circle ${circle.name}`}
          haptic="selection"
          onPress={onDelete}
          style={{ minHeight: 44, alignItems: "center", justifyContent: "center", paddingVertical: spacing.sm }}
        >
          <AppText style={{ fontSize: 15, fontWeight: "600", color: colors.destructive }}>Delete circle</AppText>
        </PressableScale>
      </GlassPanel>
    </Shell>
  );
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

function Shell({
  insets,
  title,
  overline,
  children,
}: {
  insets: number;
  title: string;
  overline?: string;
  children: React.ReactNode;
}) {
  const { instrument, spacing } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets + 8, paddingBottom: 140 }}>
        <ScreenHeader overline={overline ?? "Circle"} title={title} onBack={() => safeBack("/sharing" as Href)} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>{children}</View>
      </ScrollView>
    </View>
  );
}
