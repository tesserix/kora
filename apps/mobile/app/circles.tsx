import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";

import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { Icon } from "@/components/Icon";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { PressableScale } from "@/motion";
import { useCircles, useCreateCircle, useMemberships, useLeaveCircle } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { categoryLabel, CATEGORY_ORDER } from "@/lib/shareAudit";
import { useTheme } from "@/theme";

import type { Circle, Membership } from "@/api/types";

// The Circles screen: the list of circles and the composer (kora#444).
//
// The audit that used to head this screen has moved to Social, where it is
// the hero and is seen on every visit rather than only by someone who already
// knew to come here. This screen is now purely circle management, reached by
// tapping that audit.

function CircleRow({ circle }: { circle: Circle }) {
  const { instrument, spacing } = useTheme();
  const granted = CATEGORY_ORDER.filter((c) => circle.categories.includes(c));
  const summary =
    granted.length === 0 ? "Nothing shared" : granted.map(categoryLabel).join(" · ");

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Open circle ${circle.name}`}
      haptic="none"
      onPress={() => router.push(`/circle/${circle.id}` as Href)}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.sm }}
    >
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>{circle.name}</AppText>
        <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: 1 }}>
          {`${circle.members.length} ${circle.members.length === 1 ? "person" : "people"} · ${summary}`}
        </AppText>
      </View>
      <Icon name="chevron-right" size={14} color={instrument.mut} />
    </PressableScale>
  );
}

// A circle someone else put you in. No name — the server does not send one,
// because circle names are the owner's private labels (kora#440). What a
// member needs is who is sharing, what, and a way out.
function MembershipRow({ membership, onLeave }: { membership: Membership; onLeave: () => void }) {
  const { instrument, spacing } = useTheme();
  // A display name can legitimately be empty — the column is nullable and
  // GORM writes "" for an untouched field, so an account that never set one
  // reads as blank. Verified against a real API: this row rendered nameless.
  // A blank name here is worse than elsewhere, because the sentence beneath it
  // says this person can see your body metrics. Never fall back to email.
  const who = membership.owner.display_name.trim() || "Someone you know";
  const granted = CATEGORY_ORDER.filter((c) => membership.categories.includes(c));
  const shares =
    granted.length === 0
      ? "Shares nothing with you"
      : `Shares ${granted.map((c) => categoryLabel(c).toLowerCase()).join(" and ")} with you`;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.sm }}>
      <View style={{ flex: 1 }}>
        <AppText style={{ fontSize: 15, fontWeight: "500", color: instrument.ink }}>{who}</AppText>
        <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: 1 }}>{shares}</AppText>
      </View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Leave ${who}'s circle`}
        haptic="selection"
        onPress={onLeave}
      >
        <AppText style={{ fontSize: 15, color: instrument.mut }}>Leave</AppText>
      </PressableScale>
    </View>
  );
}

export default function Circles() {
  const { instrument, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const circlesQuery = useCircles();
  const create = useCreateCircle();
  const memberships = useMemberships();
  const leave = useLeaveCircle();
  const toast = useToast();

  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");

  const circles = circlesQuery.data ?? [];
  // #174: an outage must never render as a claim about the user's data.
  // "Nobody can see your body metrics" is a dangerously reassuring sentence
  // when the truth is that we could not ask — so the audit is REPLACED by the
  // notice rather than shown alongside it.
  const failed = circlesQuery.isError;

  const surfaceError = { onError: (error: unknown) => toast.show({ message: apiErrorMessage(error) }) };

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    create.mutate(trimmed, surfaceError);
    setName("");
    setComposing(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Who can see your data" title="Circles" onBack={() => safeBack("/social" as Href)} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {failed ? (
            <LoadErrorNotice
              testID="circles-load-error"
              message="Couldn't load your circles."
              onRetry={() => circlesQuery.refetch?.()}
            />
          ) : null}

          <View style={{ gap: spacing.xs }}>
            <AppText
              maxFontSizeMultiplier={1.4}
              style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
            >
              Circles
            </AppText>
            <GlassPanel radius={22}>
              <View style={{ paddingHorizontal: spacing.md }}>
                {circles.length === 0 && !failed ? (
                  <EmptyState
                    title="No circles yet"
                    subtitle="A circle is a named set of friends. What you share, you share with a circle."
                  />
                ) : (
                  circles.map((circle, index) => (
                    <View key={circle.id}>
                      {index > 0 ? (
                        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                      ) : null}
                      <CircleRow circle={circle} />
                    </View>
                  ))
                )}
              </View>
            </GlassPanel>
          </View>

          {/* The inbound half. Both directions of the same concept on one
              screen, because someone asking "how do I stop this?" looks where
              they went to start it (kora#440). */}
          {(memberships.data ?? []).length > 0 || memberships.isError ? (
            <View style={{ gap: spacing.xs }}>
              <AppText
                maxFontSizeMultiplier={1.4}
                style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
              >
                Shared with you
              </AppText>
              {memberships.isError ? (
                <LoadErrorNotice
                  testID="memberships-load-error"
                  message="Couldn't load what's shared with you."
                  onRetry={() => memberships.refetch?.()}
                />
              ) : (
                <GlassPanel radius={22}>
                  <View style={{ paddingHorizontal: spacing.md }}>
                    {(memberships.data ?? []).map((m, index) => (
                      <View key={m.circle_id}>
                        {index > 0 ? (
                          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                        ) : null}
                        <MembershipRow
                          membership={m}
                          onLeave={() =>
                            Alert.alert(
                              "Leave this circle?",
                              `${m.owner.display_name} will stop sharing with you. They are not told.`,
                              [
                                { text: "Cancel", style: "cancel" },
                                {
                                  text: "Leave",
                                  style: "destructive",
                                  onPress: () => leave.mutate(m.circle_id, surfaceError),
                                },
                              ],
                            )
                          }
                        />
                      </View>
                    ))}
                  </View>
                </GlassPanel>
              )}
            </View>
          ) : null}

          {composing ? (
            <GlassPanel radius={18}>
              <View style={{ padding: spacing.md, gap: spacing.sm }}>
                <TextInput
                  placeholder="Circle name"
                  placeholderTextColor={instrument.mut}
                  value={name}
                  onChangeText={setName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={submit}
                  style={{ fontSize: 16, color: instrument.ink, paddingVertical: spacing.xs }}
                />
                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing.md }}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel="Cancel new circle"
                    haptic="selection"
                    onPress={() => {
                      setComposing(false);
                      setName("");
                    }}
                  >
                    <AppText style={{ fontSize: 15, color: instrument.mut }}>Cancel</AppText>
                  </PressableScale>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel="Create circle"
                    haptic="selection"
                    onPress={submit}
                  >
                    <AppText style={{ fontSize: 15, fontWeight: "700", color: instrument.ink }}>Create</AppText>
                  </PressableScale>
                </View>
              </View>
            </GlassPanel>
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="New circle"
              haptic="selection"
              onPress={() => setComposing(true)}
              style={{
                borderRadius: radius?.md ?? 18,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: instrument.glassBorder,
                paddingVertical: spacing.md,
                alignItems: "center",
              }}
            >
              <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.mut }}>New circle</AppText>
            </PressableScale>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
