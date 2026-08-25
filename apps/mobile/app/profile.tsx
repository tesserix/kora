import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { safeBack } from "@/lib/safeBack";
import { AppText } from "@/components/Text";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppBackground } from "@/components/AppBackground";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { BezelCluster } from "@/components/instrument/BezelCluster";
import { engravedStyle, monoStyle } from "@/components/instrument/typography";
import { GroupedSection, Row } from "@/components/GroupedList";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { PressableScale } from "@/motion";
import { useClearHandle, useDeleteAvatar, useMyHandle, useProfile, useSetHandle, useUploadAvatar } from "@/api/hooks";
import { buildCaptureForm } from "@/api/resolveWire";
import type { Profile } from "@/api/types";
import { useTheme } from "@/theme";
import { formatWeight, useUnits } from "@/units";

// Duck-typed rather than `instanceof ApiError`, same reasoning as
// apiErrorMessage.ts and feedback.tsx's errorMessageFor: this screen must not
// pull @/lib/api (and firebase/auth) in just to format a string. Passing the
// server's own message through — rather than a generic replacement — is the
// whole point here: the four handle-write failures (invalid shape, reserved,
// taken, retired) answer differently, and that distinction is what tells a
// person whether to pick a different handle or fix a typo.
function errorMessageFor(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}

const GOAL_LABELS: Record<Profile["goal"], string> = {
  fat_loss: "Fat loss",
  maintenance: "Maintenance",
  muscle_gain: "Muscle gain",
};

// Falls back to "K" when the name is empty/whitespace-only — otherwise
// filter(Boolean) on the split leaves nothing to join, and the avatar renders
// an empty circle (same fallback as app/(tabs)/index.tsx's `initials`).
function initials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "K";
  return parts
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// A blank display_name is a real server state (kora#449), not a bug — never
// render the empty line that `data.display_name` alone would leave where a
// name belongs.
function displayNameFor(name: string): string {
  return name.trim().length > 0 ? name : "Kora member";
}

function humanizeGoal(goal: string | undefined): string {
  if (!goal) return "—";
  return GOAL_LABELS[goal as Profile["goal"]] ?? goal;
}

// Formats an ISO date as e.g. "March 2025". Never fabricates a date when the
// server hasn't reported one — falls back to an explicit placeholder.
function formatMemberSince(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function ProfileScreen() {
  const { instrument, spacing, radius, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useProfile();
  const data = profile.data;
  const { system } = useUnits();
  const fw = data ? formatWeight(data.weight_kg, system) : null;
  const mono = monoStyle(fonts);
  const duoLabel = [engravedStyle(instrument), { marginBottom: spacing.xs }];

  const myHandle = useMyHandle();
  const setHandle = useSetHandle();
  const clearHandle = useClearHandle();
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();

  // null means "no local edit yet" -- the field reads straight from the
  // server's answer. Set the instant the person types, and cleared back to
  // null on a successful save/remove so the field reads from the server
  // again (avoiding a setState-in-effect to keep the two in sync, which
  // would trigger a cascading render on every fetch).
  const [handleOverride, setHandleOverride] = useState<string | null>(null);
  const handleInput = handleOverride ?? myHandle.data?.handle ?? "";
  const [handleErr, setHandleErr] = useState<string | null>(null);
  const [pictureErr, setPictureErr] = useState<string | null>(null);

  const onSaveHandle = async () => {
    setHandleErr(null);
    try {
      await setHandle.mutateAsync(handleInput.trim());
      setHandleOverride(null);
    } catch (e) {
      setHandleErr(errorMessageFor(e));
    }
  };

  // Removing is immediate and ungated -- no confirmation dialog -- mirroring
  // the sharing circles' revoke: a surface that makes stopping harder than
  // starting works against the person it exists for.
  const onRemoveHandle = async () => {
    setHandleErr(null);
    try {
      await clearHandle.mutateAsync();
      setHandleOverride(null);
    } catch (e) {
      setHandleErr(errorMessageFor(e));
    }
  };

  const onRemovePicture = async () => {
    setPictureErr(null);
    try {
      await deleteAvatar.mutateAsync();
    } catch (e) {
      setPictureErr(errorMessageFor(e));
    }
  };

  const pickPicture = async () => {
    setPictureErr(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPictureErr("Kora needs access to your photos to set a picture.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      // The API centre-crops to a square anyway; letting the user choose the
      // crop means the face they meant is the face that is kept.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (picked.canceled || !picked.assets?.[0]) return;

    const asset = picked.assets[0];
    // buildCaptureForm is the ONE multipart body shape Expo's winter-runtime
    // fetch can send — see the comment on it in src/api/resolveWire.ts. A
    // hand-built { uri, name, type } part throws before any I/O.
    const form = buildCaptureForm({
      uri: asset.uri,
      name: asset.fileName ?? "avatar.jpg",
      type: asset.mimeType ?? "image/jpeg",
    });
    try {
      await uploadAvatar.mutateAsync(form);
    } catch (e) {
      setPictureErr(errorMessageFor(e));
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
      >
        <ScreenHeader overline="Your account" title="Profile" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
          {/* Identity hero: one bezel cluster carries avatar, name, handle and
              email together (spec: More "bezel identity hero (56px avatar
              well + name + mono email)"). The screen's one accent SURFACE is
              the whisper of orange lume behind the avatar well below —
              change/remove picture and remove-handle are text links demoted
              to lit-ink/danger, never accent. "Save handle" is the one
              exception: it's the screen's sole primary write action, styled
              as a ghost CTA rather than a filled accent button, which is the
              contract's own precedent for a primary action (screens-and-
              accent.md: "ghost-CTA plus stays (primary action)", same as
              Home's "Log a meal" / Diary's "Add dinner"). A ghost label is
              accent-colored text with no filled surface, not a second accent
              block competing with the avatar glow. */}
          <BezelCluster radius={25} testID="profile-identity-hero">
            <View style={{ padding: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View
                  style={{
                    borderRadius: 999,
                    shadowColor: instrument.accent,
                    shadowOpacity: 0.35,
                    shadowRadius: 20,
                    shadowOffset: { width: 0, height: 0 },
                  }}
                >
                  <Avatar initials={data ? initials(data.display_name) : "—"} uri={data?.avatar_url} size={56} />
                </View>
                <View style={{ flex: 1, marginLeft: spacing.md }}>
                  <AppText
                    numberOfLines={1}
                    style={{ fontSize: 18, fontWeight: "700", color: instrument.ink }}
                  >
                    {data ? displayNameFor(data.display_name) : "Loading…"}
                  </AppText>
                  {myHandle.data?.handle ? (
                    <AppText numberOfLines={1} style={[{ fontSize: 13, color: instrument.mut, marginTop: 1 }, mono]}>
                      {`@${myHandle.data.handle}`}
                    </AppText>
                  ) : null}
                  <AppText numberOfLines={1} style={[{ fontSize: 13, color: instrument.mut, marginTop: 1 }, mono]}>
                    {data ? data.email : "—"}
                  </AppText>
                </View>
              </View>

              {/* Compact picture affordances — text links, not full-width
                  ghost buttons, so this stays a single line instead of its
                  own stacked row. Each link is wrapped at minHeight: 44 (the
                  dominant pattern for this, e.g. app/social.tsx's
                  OverflowRow/PersonRow/GroupRow, InviteFriendSheet.tsx:54,
                  FriendsLeaderboard.tsx:60) rather than hitSlop, because a
                  13px label's own line box is only ~17-18pt tall — hitSlop
                  alone can't reach the 44pt iOS minimum without also risking
                  the two links' hit areas overlapping across the spacing.lg
                  gap between them (kora#446 already had to fix one
                  neighbouring surface for exactly this). minHeight avoids
                  both problems: the full 44pt lands on each link without
                  extending sideways into the other's space. */}
              <View style={{ flexDirection: "row", gap: spacing.lg, marginTop: spacing.sm }}>
                <PressableScale
                  testID="profile-change-picture-target"
                  accessibilityRole="button"
                  haptic="none"
                  onPress={pickPicture}
                  disabled={uploadAvatar.isPending}
                  style={{ minHeight: 44, justifyContent: "center" }}
                >
                  <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.ink }}>
                    Change picture
                  </AppText>
                </PressableScale>
                {data?.avatar_url ? (
                  <PressableScale
                    accessibilityRole="button"
                    haptic="none"
                    onPress={onRemovePicture}
                    disabled={deleteAvatar.isPending}
                    style={{ minHeight: 44, justifyContent: "center" }}
                  >
                    <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.danger }}>
                      Remove picture
                    </AppText>
                  </PressableScale>
                ) : null}
              </View>
              {pictureErr ? (
                <AppText accessibilityRole="alert" style={{ color: instrument.danger, fontSize: 13, marginTop: spacing.xs }}>
                  {pictureErr}
                </AppText>
              ) : null}

              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: instrument.hairline,
                  marginVertical: spacing.md,
                }}
              />

              <AppText style={{ fontSize: 13, color: instrument.mut, marginBottom: spacing.xs }}>
                {myHandle.data?.handle ? "Your handle" : "Pick a handle"}
              </AppText>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <TextInput
                  value={handleInput}
                  onChangeText={(t) => {
                    setHandleOverride(t);
                    setHandleErr(null);
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="e.g. ada"
                  placeholderTextColor={instrument.mut}
                  accessibilityLabel="Handle"
                  style={{
                    flex: 1,
                    fontSize: 16,
                    color: instrument.ink,
                    backgroundColor: instrument.inset,
                    borderRadius: radius.lg,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                  }}
                />
                <Button
                  title="Save handle"
                  variant="ghost"
                  onPress={onSaveHandle}
                  disabled={setHandle.isPending || handleInput.trim().length === 0}
                />
              </View>
              {handleErr ? (
                <AppText accessibilityRole="alert" style={{ color: instrument.danger, fontSize: 13, marginTop: spacing.xs }}>
                  {handleErr}
                </AppText>
              ) : null}
              {myHandle.data?.handle ? (
                <PressableScale
                  accessibilityRole="button"
                  haptic="none"
                  onPress={onRemoveHandle}
                  style={{ marginTop: spacing.sm, alignSelf: "flex-start", minHeight: 44, justifyContent: "center" }}
                >
                  <AppText style={{ fontSize: 13, fontWeight: "600", color: instrument.danger }}>
                    Remove handle
                  </AppText>
                </PressableScale>
              ) : null}
            </View>
          </BezelCluster>

          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Daily targets
            </AppText>
            <GlassPanel radius={22} style={{ padding: spacing.md }}>
              <View style={{ flexDirection: "row", justifyContent: "flex-end", marginBottom: spacing.sm }}>
                <View
                  style={{
                    paddingHorizontal: spacing.sm,
                    paddingVertical: spacing.xs / 2,
                    borderRadius: 999,
                    backgroundColor: instrument.inset,
                    borderWidth: 1,
                    borderColor: instrument.glassBorder,
                  }}
                >
                  <AppText
                    style={{
                      fontSize: 10,
                      letterSpacing: 1,
                      textTransform: "uppercase",
                      fontWeight: "700",
                      color: instrument.mut,
                    }}
                  >
                    {humanizeGoal(data?.goal)}
                  </AppText>
                </View>
              </View>

              {/* flexWrap, not flexShrink: with nothing given, neither side
                  yields and "kcal / day" is clipped by the screen edge at
                  accessibility sizes; with flexShrink on the unit the box
                  narrows below the word and the unit breaks MID-WORD instead
                  (measured: "k / g" on the weight card below). Wrapping moves
                  the unit to its own line whole, and the numeral -- the
                  reading -- never splits. Unchanged at medium, where both
                  still fit one line. (kora#173) */}
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "baseline",
                  gap: spacing.xs,
                  marginBottom: spacing.md,
                }}
              >
                {/* Explicit lineHeight: large mono numerals clip their ascent
                    without it (same class as the GaugeDial center-numeral bug). */}
                <AppText
                  style={[
                    { fontSize: 40, lineHeight: 46, fontWeight: "700", color: instrument.ink },
                    mono,
                  ]}
                >
                  {data ? Math.round(data.target_kcal) : "—"}
                </AppText>
                <AppText style={{ fontSize: 13, color: instrument.mut }}>kcal / day</AppText>
              </View>

              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Protein</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_protein_g)}g` : "—"}
                  </AppText>
                </View>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Carbs</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_carbs_g)}g` : "—"}
                  </AppText>
                </View>
                <View>
                  <AppText style={{ fontSize: 13, color: instrument.mut }}>Fat</AppText>
                  <AppText style={[{ fontSize: 17, fontWeight: "700", color: instrument.ink }, mono]}>
                    {data ? `${Math.round(data.target_fat_g)}g` : "—"}
                  </AppText>
                </View>
              </View>
            </GlassPanel>
          </View>

          <View style={{ flexDirection: "row", gap: spacing.lg }}>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md, minHeight: 84, justifyContent: "center" }}>
              <AppText style={duoLabel}>Weight</AppText>
              {/* Same treatment as the energy readout above; here the edge
                  that clips is the card's, not the screen's. flexShrink on
                  the unit was measured breaking "kg" into "k" / "g" -- a
                  two-letter unit has no break point worth taking, so the row
                  wraps instead and the unit drops to its own line whole
                  (kora#173). */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: spacing.xs }}>
                <AppText style={[{ fontSize: 24, fontWeight: "700", color: instrument.ink }, mono]}>
                  {fw ? fw.value : "—"}
                </AppText>
                <AppText variant="subheadline" style={{ color: instrument.mut }}>{fw ? fw.unit : "kg"}</AppText>
              </View>
            </GlassPanel>
            <GlassPanel radius={22} style={{ flex: 1, padding: spacing.md, minHeight: 84, justifyContent: "center" }}>
              <AppText style={duoLabel}>Member since</AppText>
              <AppText variant="headline" style={{ color: instrument.ink }}>
                {data ? formatMemberSince(data.onboarded_at) : "—"}
              </AppText>
            </GlassPanel>
          </View>

          <View>
            <AppText style={[engravedStyle(instrument), { marginLeft: spacing.md, marginBottom: spacing.xs }]}>
              Account
            </AppText>
            <GroupedSection>
              <Row
                title="Delete account"
                destructive
                chevron
                onPress={() => router.push("/delete-account")}
              />
            </GroupedSection>
            <AppText style={{ fontSize: 13, color: instrument.mut, marginLeft: spacing.md, marginTop: spacing.xs }}>
              Permanently deletes your account and all your data.
            </AppText>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
