import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, type Href } from "expo-router";

import { safeBack } from "@/lib/safeBack";
import { isNotFound } from "@/lib/apiStatus";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { EmptyState } from "@/components/common/EmptyState";
import { LoadErrorNotice } from "@/components/common/LoadErrorNotice";
import { useFriendBody, useFriends } from "@/api/hooks";
import { useTheme } from "@/theme";

import type { FriendBodyEntry } from "@/api/types";

// A friend's body metrics, when they have granted it (kora#441).
//
// This is the consumer that makes access.CategoryBody control something a
// person can actually see. Before it, the grant was settable and auditable but
// invisible to the one person it was granted to.
//
// Three rules this screen inherits, all of them easy to get wrong:
//
//  1. A 404 is NOT an error. The server returns it for not-shared, not-a-
//     friend, no-such-person and reading-yourself, deliberately
//     indistinguishable — so this renders ONE calm state for all of them, with
//     no retry prompt and nothing that reads as "something went wrong".
//  2. A missing metric means NOT MEASURED, never zero. Every field is
//     optional and omitted when absent; a friend who only records weight must
//     not appear to have 0% body fat.
//  3. local_date is the OWNER's device-local day at capture. It is never
//     re-derived from logged_at in the viewer's timezone, which would shift
//     entries across day boundaries for anyone in a different zone.

// The metrics a viewer sees, in a fixed order with their units. Deliberately a
// subset of what the endpoint can return: a viewer wants a trend and a recent
// picture, not every tape measurement the owner has ever recorded.
const SHOWN: { key: keyof FriendBodyEntry; label: string; unit: string }[] = [
  { key: "body_fat_pct", label: "Body fat", unit: "%" },
  { key: "muscle_mass_kg", label: "Muscle mass", unit: "kg" },
  { key: "waist_cm", label: "Waist", unit: "cm" },
  { key: "chest_cm", label: "Chest", unit: "cm" },
  { key: "hip_cm", label: "Hip", unit: "cm" },
];

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// The owner's own local day, formatted without reinterpreting it. Taking the
// date part of the string avoids constructing a Date in the viewer's zone,
// which is what would move an entry to the wrong day.
function localDay(entry: FriendBodyEntry): string {
  return (entry.local_date ?? "").slice(0, 10);
}

export default function FriendBody() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const friends = useFriends();
  const body = useFriendBody(id);

  const friend = (friends.data ?? []).find((f) => f.id === id);
  const name = friend?.display_name?.trim() || "This person";

  const notShared = isNotFound(body.error);
  const failed = body.isError && !notShared;

  // isPending, not isLoading: with gcTime 0 a remount has no cached data, and
  // `data` is undefined while the request is in flight. Without this branch
  // `entries` is [] mid-flight and the screen renders "Nothing recorded yet"
  // — a claim about another person's data made before we know anything, the
  // same defect class as #174. Caught on device: a friend with five weigh-ins
  // read as having none.
  const loading = body.isPending;
  const entries = body.data ?? [];
  const latest = entries.length > 0 ? entries[entries.length - 1] : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}>
        <ScreenHeader overline="Body metrics" title={name} onBack={() => safeBack("/social" as Href)} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {loading ? (
            <AppText testID="friend-body-loading" style={{ fontSize: 14, color: instrument.mut }}>
              Loading…
            </AppText>
          ) : failed ? (
            <LoadErrorNotice
              testID="friend-body-load-error"
              message="Couldn't load their body metrics."
              onRetry={() => body.refetch?.()}
            />
          ) : notShared ? (
            // Not-shared, not-a-friend, no-such-person and reading-yourself
            // all arrive as one 404 and must read as one calm state. It must
            // not imply they are withholding, and must not imply they have no
            // data — the server deliberately does not tell us which.
            <EmptyState
              title="Nothing shared with you"
              subtitle="If they share their body metrics with you, they will show up here."
            />
          ) : entries.length === 0 ? (
            // A DIFFERENT fact, and worth saying so: a 200 with an empty
            // series means they do share with you and simply have not recorded
            // anything. Collapsing this into the 404 copy above told a viewer
            // who holds a grant that they hold nothing — and distinguishing
            // them leaks nothing, because someone holding a grant is entitled
            // to know they hold it. Found on device, where a granted friend
            // with no weigh-ins read as "nothing shared with you".
            <EmptyState
              title="Nothing recorded yet"
              subtitle="They share their body metrics with you, but have not logged a weigh-in."
            />
          ) : (
            <>
              <BezelCluster radius={25} testID="friend-body-latest">
                <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                  <AppText
                    maxFontSizeMultiplier={1.4}
                    style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
                  >
                    {`Latest · ${localDay(latest!)}`}
                  </AppText>
                  <AppText
                    testID="friend-body-weight"
                    maxFontSizeMultiplier={1.4}
                    style={{ fontFamily: "Menlo", fontSize: 34, fontWeight: "600", color: instrument.accent, marginTop: 2 }}
                  >
                    {`${fmt(latest!.weight_kg)} kg`}
                  </AppText>
                </View>
              </BezelCluster>

              <View style={{ gap: spacing.xs }}>
                <AppText
                  maxFontSizeMultiplier={1.4}
                  style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: instrument.mut }}
                >
                  Latest readings
                </AppText>
                <GlassPanel radius={22}>
                  <View style={{ paddingHorizontal: spacing.md }}>
                    {SHOWN.map((m, index) => {
                      const raw = latest![m.key];
                      const value = typeof raw === "number" ? `${fmt(raw)}${m.unit}` : "Not measured";
                      return (
                        <View key={String(m.key)}>
                          {index > 0 ? (
                            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} />
                          ) : null}
                          <View
                            style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingVertical: spacing.xs }}
                          >
                            <AppText style={{ flex: 1, fontSize: 15, color: instrument.ink }}>{m.label}</AppText>
                            <AppText
                              testID={`friend-body-${String(m.key)}`}
                              style={{
                                fontFamily: typeof raw === "number" ? "Menlo" : undefined,
                                fontSize: typeof raw === "number" ? 15 : 14,
                                color: typeof raw === "number" ? instrument.ink : instrument.mut,
                              }}
                            >
                              {value}
                            </AppText>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </GlassPanel>
              </View>

              <AppText style={{ fontSize: 13, color: instrument.mut }}>
                {`${entries.length} ${entries.length === 1 ? "weigh-in" : "weigh-ins"} shared with you.`}
              </AppText>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
