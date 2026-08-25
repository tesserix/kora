import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, type Href } from "expo-router";

import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { Icon } from "@/components/Icon";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { PressableScale } from "@/motion";
import { useCircles, useCreateCircle } from "@/api/hooks";
import { useToast } from "@/components/Toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { audienceFor, categoryLabel, CATEGORY_ORDER } from "@/lib/shareAudit";
import { useTheme } from "@/theme";

import type { Circle, ShareCategory } from "@/api/types";

// The Sharing screen (kora#437, spec §Surfaces).
//
// The audit comes FIRST, before the circles that produce it, because "who can
// see my data" is the question people arrive with — the circles are the
// mechanism, not the answer. It is cheap to put here precisely because grants
// come only from circles: the names are a fold over the response the list
// below already needs, not a second request.
//
// Accent budget: this screen's one hero moment is the body audience count in
// the cluster. Category chips, member counts and the circle list are all
// lit-ink; nothing else takes accent.

function AuditRow({ category, circles, hero }: { category: ShareCategory; circles: Circle[]; hero: boolean }) {
  const { instrument, spacing } = useTheme();
  const audience = audienceFor(circles, category);
  // "Nobody" rather than "0 people": zero is a count, and the answer most
  // users should see most of the time deserves a word, not a numeral.
  const names = audience.length === 0 ? "Nobody" : audience.map((m) => m.display_name).join(", ");

  return (
    <View style={{ paddingVertical: spacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
        <AppText
          testID={`audit-count-${category}`}
          style={{
            fontFamily: "Menlo",
            fontSize: 28,
            fontWeight: "600",
            color: hero && audience.length > 0 ? instrument.accent : instrument.ink,
          }}
        >
          {audience.length}
        </AppText>
        <AppText
          maxFontSizeMultiplier={1.4}
          style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
        >
          {`can see ${categoryLabel(category)}`}
        </AppText>
      </View>
      <AppText
        testID={`audit-names-${category}`}
        style={{ fontSize: 14, color: audience.length === 0 ? instrument.mut : instrument.ink, marginTop: 2 }}
      >
        {names}
      </AppText>
    </View>
  );
}

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

export default function Sharing() {
  const { instrument, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const circlesQuery = useCircles();
  const create = useCreateCircle();
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
        <ScreenHeader overline="Who can see your data" title="Sharing" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {failed ? (
            <LoadErrorNotice
              testID="sharing-load-error"
              message="Couldn't load your sharing settings."
              onRetry={() => circlesQuery.refetch?.()}
            />
          ) : (
            <BezelCluster radius={25} testID="sharing-audit">
              <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                {CATEGORY_ORDER.map((category, index) => (
                  <View key={category}>
                    {index > 0 ? (
                      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                    ) : null}
                    <AuditRow category={category} circles={circles} hero={category === "body"} />
                  </View>
                ))}
              </View>
            </BezelCluster>
          )}

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
