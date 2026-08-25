import { StyleSheet, View } from "react-native";
import { router, type Href } from "expo-router";

import { AppText } from "@/components/Text";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { PressableScale } from "@/motion";
import { audienceFor, categoryLabel, CATEGORY_ORDER } from "@/lib/shareAudit";
import { useTheme } from "@/theme";

import type { Circle, ShareCategory } from "@/api/types";

// The Social screen's hero: "who can see your data", answered before anything
// else on the screen (kora#444).
//
// This sits above Friends and Groups deliberately. Sharing is a privacy
// control, and the alternative consolidation — burying it behind a segment —
// would have made a data-sharing setting HARDER to find. Promoting the audit
// to the header makes it more discoverable than the row it replaces.
//
// The whole cluster is one press target rather than carrying a chevron, and it
// is the screen's single hero accent moment; nothing else on Social competes
// for accent.

// A hero mono numeral that can legitimately be zero must never render "0" as
// its sole content — say it in words instead.
//
// This is a house rule, not a local tweak. It fixes two defects at once
// (kora#443): the redundancy of rendering "0" above the word "Nobody", and
// Menlo's slashed zero reading as the letter "Ø" at 28px. Solving it
// structurally rather than typographically means the ambiguous glyph is simply
// absent from the state almost every user sees, instead of being restyled and
// still ambiguous.
function AuditRow({ category, circles, hero }: { category: ShareCategory; circles: Circle[]; hero: boolean }) {
  const { instrument, spacing } = useTheme();
  const audience = audienceFor(circles, category);
  const label = categoryLabel(category).toLowerCase();

  if (audience.length === 0) {
    return (
      <View
        accessible
        accessibilityLabel={`Nobody can see your ${label}`}
        testID={`audit-row-${category}`}
        style={{ paddingVertical: spacing.sm }}
      >
        <AppText
          testID={`audit-empty-${category}`}
          style={{ fontSize: 15, color: instrument.mut }}
        >
          {`Nobody can see your ${label}`}
        </AppText>
      </View>
    );
  }

  const names = audience.map((m) => m.display_name).join(", ");
  return (
    <View
      accessible
      accessibilityLabel={`${audience.length}, can see ${label}: ${names}`}
      testID={`audit-row-${category}`}
      style={{ paddingVertical: spacing.sm }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm }}>
        <AppText
          testID={`audit-count-${category}`}
          maxFontSizeMultiplier={1.4}
          style={{
            fontFamily: "Menlo",
            fontSize: 28,
            fontWeight: "600",
            color: hero ? instrument.accent : instrument.ink,
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
      <AppText testID={`audit-names-${category}`} style={{ fontSize: 14, color: instrument.ink, marginTop: 2 }}>
        {names}
      </AppText>
    </View>
  );
}

// hintFor names the NEXT step, and only when there is no audience at all.
//
// "No circles" and "a circle with no members" deliberately collapse to the
// same sentence here: from Social's vantage both mean "nobody can see
// anything", and the distinction is only actionable inside Circles, where the
// empty circle is visible and explains itself.
function hintFor(circles: Circle[], hasAudience: boolean): string | null {
  if (hasAudience) return null;
  if (circles.length === 0) return "Sharing starts with a circle — build one from a friend below.";
  return "Turn a friend into a circle to start sharing.";
}

interface SocialAuditProps {
  circles: Circle[];
  failed: boolean;
  onRetry?: () => void;
}

export function SocialAudit({ circles, failed, onRetry }: SocialAuditProps) {
  const { instrument, spacing } = useTheme();

  // #174: an outage must never render as a claim about the user's data.
  // "Nobody can see your body metrics" is a dangerously reassuring sentence
  // when the truth is that we could not ask — so the notice REPLACES the
  // cluster rather than sitting beside it.
  if (failed) {
    return (
      <LoadErrorNotice
        testID="audit-load-error"
        message="Couldn't load who can see your data."
        onRetry={onRetry}
      />
    );
  }

  const hasAudience = CATEGORY_ORDER.some((c) => audienceFor(circles, c).length > 0);
  const hint = hintFor(circles, hasAudience);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel="Who can see your data"
      accessibilityHint="Opens your circles"
      haptic="none"
      onPress={() => router.push("/circles" as Href)}
    >
      <BezelCluster radius={25} testID="social-audit">
        <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
          {CATEGORY_ORDER.map((category, index) => (
            <View key={category}>
              {index > 0 ? (
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
              ) : null}
              <AuditRow category={category} circles={circles} hero={category === "body"} />
            </View>
          ))}
          {hint ? (
            <AppText
              testID="audit-hint"
              style={{ fontSize: 13, color: instrument.mut, paddingTop: spacing.xs, paddingBottom: spacing.xs }}
            >
              {hint}
            </AppText>
          ) : null}
        </View>
      </BezelCluster>
    </PressableScale>
  );
}
