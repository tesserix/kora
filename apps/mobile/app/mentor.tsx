import { useState } from "react";
import { FlatList, Platform, StyleSheet, Switch, TextInput, View } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import type {
  MentorCoachingStyle,
  MentorCommitment,
  MentorFoodRuleKind,
  MentorProfileInput,
  MentorReminderIntensity,
} from "@/api/types";
import {
  useConfirmMentorFoodRule,
  useDeleteMentorFoodRule,
  useDeleteMentorHealth,
  useMentorCommitments,
  useMentorFoodRules,
  useMentorProfile,
  usePutMentorCommitment,
  usePutMentorFoodRules,
  usePutMentorProfile,
} from "@/api/hooks";
import { FoodRulesCard } from "@/components/mentor/FoodRulesCard";
import { AppBackground } from "@/components/AppBackground";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { engravedStyle } from "@/components/instrument/typography";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { pauseMentorHealthSync } from "@/mentor/healthSyncGate";

const COACHING_STYLES: { key: MentorCoachingStyle; label: string }[] = [
  { key: "supportive", label: "Supportive" },
  { key: "direct", label: "Direct" },
  { key: "educational", label: "Educational" },
  { key: "accountability", label: "Accountability" },
];

const REMINDER_OPTIONS = [
  { key: "light", label: "Light" },
  { key: "balanced", label: "Balanced" },
  { key: "frequent", label: "Frequent" },
];

const EMPTY_PROFILE: MentorProfileInput = {
  motivation: "",
  dietary_preferences: "",
  allergies: "",
  diet_pattern: "",
  coaching_style: "supportive",
  reminder_intensity: "balanced",
  quiet_start_minute: 22 * 60,
  quiet_end_minute: 7 * 60,
  health_steps_enabled: false,
  health_sleep_enabled: false,
  health_workouts_enabled: false,
  health_energy_enabled: false,
  health_heart_rate_enabled: false,
};

function inputFromProfile(profile: MentorProfileInput): MentorProfileInput {
  return {
    motivation: profile.motivation,
    dietary_preferences: profile.dietary_preferences,
    allergies: profile.allergies,
    diet_pattern: profile.diet_pattern,
    coaching_style: profile.coaching_style,
    reminder_intensity: profile.reminder_intensity,
    quiet_start_minute: profile.quiet_start_minute,
    quiet_end_minute: profile.quiet_end_minute,
    health_steps_enabled: profile.health_steps_enabled,
    health_sleep_enabled: profile.health_sleep_enabled,
    health_workouts_enabled: profile.health_workouts_enabled,
    health_energy_enabled: profile.health_energy_enabled,
    health_heart_rate_enabled: profile.health_heart_rate_enabled,
  };
}

function timeValue(minute: number): Date {
  return new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
}

function formatTime(minute: number): string {
  const hour = Math.floor(minute / 60);
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${suffix}`;
}

function scheduleText(item: MentorCommitment): string {
  const start = formatTime(item.start_minute);
  if (item.cadence === "fixed") return start;
  return `${start}–${formatTime(item.end_minute ?? item.start_minute)} · every ${item.interval_minutes} min`;
}

type HealthToggleProps = {
  label: string;
  detail: string;
  testID: string;
  value: boolean;
  onChange: (value: boolean) => void;
};

function HealthToggle({ label, detail, testID, value, onChange }: HealthToggleProps) {
  const { instrument, spacing } = useTheme();
  return (
    <View style={{ minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
      <View style={{ flex: 1 }}>
        <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{label}</AppText>
        <AppText style={{ color: instrument.mut, fontSize: 12 }}>{detail}</AppText>
      </View>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: instrument.inset, true: instrument.teal }}
      />
    </View>
  );
}

export default function MentorScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const profile = useMentorProfile();
  const commitments = useMentorCommitments();
  const foodRules = useMentorFoodRules();
  const putProfile = usePutMentorProfile();
  const deleteHealth = useDeleteMentorHealth();
  const putCommitment = usePutMentorCommitment();
  const putFoodRules = usePutMentorFoodRules();
  const confirmFoodRule = useConfirmMentorFoodRule();
  const deleteFoodRule = useDeleteMentorFoodRule();
  const [draft, setDraft] = useState<MentorProfileInput>(EMPTY_PROFILE);
  const [hydratedProfileVersion, setHydratedProfileVersion] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState<"start" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const profileVersion = profile.data?.updated_at ?? null;
  if (profile.data && hydratedProfileVersion !== profileVersion) {
    setHydratedProfileVersion(profileVersion);
    setDraft(inputFromProfile(profile.data));
  }

  const update = <K extends keyof MentorProfileInput>(key: K, value: MentorProfileInput[K]): void => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const changeTime = (event: DateTimePickerEvent, value?: Date): void => {
    if (Platform.OS !== "ios" || event.type === "dismissed") setEditingTime(null);
    if (!value || event.type === "dismissed" || !editingTime) return;
    update(editingTime === "start" ? "quiet_start_minute" : "quiet_end_minute", value.getHours() * 60 + value.getMinutes());
  };

  const save = async (): Promise<void> => {
    const previous = profile.data;
    const revoked = !!previous && (
      (previous.health_steps_enabled && !draft.health_steps_enabled)
      || (previous.health_sleep_enabled && !draft.health_sleep_enabled)
      || (previous.health_workouts_enabled && !draft.health_workouts_enabled)
      || (previous.health_energy_enabled && !draft.health_energy_enabled)
      || (previous.health_heart_rate_enabled && !draft.health_heart_rate_enabled)
    );
    setError(null);
    setSaved(false);
    const healthSyncPause = revoked ? pauseMentorHealthSync() : null;
    try {
      await healthSyncPause?.waitForIdle;
      await putProfile.mutateAsync(draft);
      if (revoked) await deleteHealth.mutateAsync();
      // A saved diet pattern and the free-text notes expand into rules on the
      // server, so the rules list is stale the moment the profile lands.
      void foodRules.refetch();
      setSaved(true);
    } catch {
      setError("Your mentor settings could not be saved. Please try again.");
    } finally {
      healthSyncPause?.resume();
    }
  };

  // A rules PUT replaces the user's own set, so an add sends the existing
  // user-authored rules alongside the new one. Pattern- and coach-authored
  // rules are the server's to keep.
  const addFoodRule = async (subject: string, kind: MentorFoodRuleKind): Promise<void> => {
    const existing = (foodRules.data?.rules ?? [])
      .filter((rule) => rule.source === "user")
      .map((rule) => ({ subject: rule.subject, kind: rule.kind, severity: rule.severity }));
    setError(null);
    try {
      await putFoodRules.mutateAsync([...existing, { subject, kind }]);
    } catch {
      setError("That food rule could not be saved. Please try again.");
    }
  };

  const changeFoodRule = async (run: Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await run;
    } catch {
      setError("That food rule could not be changed. Please try again.");
    }
  };

  const toggleCommitment = async (item: MentorCommitment, active: boolean): Promise<void> => {
    setError(null);
    try {
      await putCommitment.mutateAsync({ ...item, status: active ? "active" : "paused" });
    } catch {
      setError("That commitment could not be changed. Please try again.");
    }
  };

  if (profile.isPending || commitments.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: instrument.bg, alignItems: "center", justifyContent: "center" }}>
        <AppBackground />
        <AppText>Preparing your mentor…</AppText>
      </View>
    );
  }

  if (profile.isError || commitments.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: instrument.bg }}>
        <AppBackground />
        <ScreenHeader overline="Health intelligence" title="Personal Mentor" onBack={() => safeBack("/(tabs)/more")} />
        <View style={{ paddingHorizontal: 20, gap: spacing.md }}>
          <AppText style={{ color: instrument.mut }}>Your mentor settings could not be loaded.</AppText>
          <Button title="Retry" onPress={() => { void profile.refetch(); void commitments.refetch(); }} />
        </View>
      </View>
    );
  }

  const activeCommitments = (commitments.data ?? []).filter((item) => item.status !== "archived");
  const inputStyle = {
    minHeight: 46,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: instrument.ink,
    backgroundColor: instrument.inset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: instrument.glassBorder,
    fontSize: 15,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <FlatList
        data={activeCommitments}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 80 }}
        ListHeaderComponent={(
          <>
            <ScreenHeader overline="Health intelligence" title="Personal Mentor" onBack={() => safeBack("/(tabs)/more")} />
            <View style={{ paddingHorizontal: 20 }}>
              <BezelCluster radius={26} testID="mentor-profile-cluster">
                <View style={{ padding: spacing.md, gap: spacing.md }}>
                  <View>
                    <AppText variant="title2" style={{ color: instrument.ink }}>A mentor that learns your rhythm</AppText>
                    <AppText style={{ color: instrument.mut, marginTop: spacing.xs }}>
                      Tell Kora what matters to you. Your Coach and Nutrition Coach use these confirmed preferences to make guidance personal.
                    </AppText>
                  </View>

                  <ZoneRule label="Your context" />
                  <TextInput
                    accessibilityLabel="What motivates you"
                    placeholder="What would feeling healthier make possible?"
                    placeholderTextColor={instrument.mut}
                    value={draft.motivation}
                    onChangeText={(value) => update("motivation", value)}
                    maxLength={500}
                    multiline
                    style={[inputStyle, { minHeight: 72, textAlignVertical: "top" }]}
                  />
                  <TextInput
                    accessibilityLabel="Dietary preferences"
                    placeholder="Dietary preferences"
                    placeholderTextColor={instrument.mut}
                    value={draft.dietary_preferences}
                    onChangeText={(value) => update("dietary_preferences", value)}
                    maxLength={500}
                    style={inputStyle}
                  />
                  <TextInput
                    accessibilityLabel="Allergies and foods to avoid"
                    placeholder="Allergies or foods to avoid"
                    placeholderTextColor={instrument.mut}
                    value={draft.allergies}
                    onChangeText={(value) => update("allergies", value)}
                    maxLength={500}
                    style={inputStyle}
                  />

                  <FoodRulesCard
                    pattern={draft.diet_pattern}
                    patterns={foodRules.data?.patterns ?? []}
                    rules={foodRules.data?.rules ?? []}
                    subjects={foodRules.data?.subjects ?? []}
                    onPatternChange={(value) => update("diet_pattern", value)}
                    onAdd={(subject, kind) => { void addFoodRule(subject, kind); }}
                    onConfirm={(subject) => { void changeFoodRule(confirmFoodRule.mutateAsync(subject)); }}
                    onRemove={(subject) => { void changeFoodRule(deleteFoodRule.mutateAsync(subject)); }}
                  />

                  <AppText style={engravedStyle(instrument)}>Coaching style</AppText>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                    {COACHING_STYLES.map((style) => {
                      const selected = draft.coaching_style === style.key;
                      return (
                        <PressableScale
                          key={style.key}
                          accessibilityRole="radio"
                          accessibilityLabel={style.label}
                          accessibilityState={{ checked: selected }}
                          onPress={() => update("coaching_style", style.key)}
                          haptic="selection"
                          style={{
                            minHeight: 44,
                            minWidth: "47%",
                            flexGrow: 1,
                            borderRadius: 12,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: selected ? instrument.ink : instrument.inset,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: selected ? instrument.ink : instrument.glassBorder,
                          }}
                        >
                          <AppText style={{ color: selected ? instrument.bg : instrument.mut, fontWeight: "600" }}>
                            {style.label}
                          </AppText>
                        </PressableScale>
                      );
                    })}
                  </View>

                  <AppText style={engravedStyle(instrument)}>Reminder rhythm</AppText>
                  <SegmentedGlass
                    testID="mentor-reminder-intensity"
                    options={REMINDER_OPTIONS}
                    value={draft.reminder_intensity}
                    onChange={(value) => update("reminder_intensity", value as MentorReminderIntensity)}
                  />

                  <ZoneRule label="Quiet hours" />
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    {(["start", "end"] as const).map((field) => {
                      const minute = field === "start" ? draft.quiet_start_minute : draft.quiet_end_minute;
                      return (
                        <PressableScale
                          key={field}
                          accessibilityRole="button"
                          accessibilityLabel={`Quiet hours ${field}`}
                          onPress={() => setEditingTime(field)}
                          haptic="selection"
                          style={{ flex: 1, minHeight: 50, borderRadius: 12, backgroundColor: instrument.inset, alignItems: "center", justifyContent: "center" }}
                        >
                          <AppText style={{ color: instrument.mut, fontSize: 11, textTransform: "uppercase" }}>{field}</AppText>
                          <AppText style={{ color: instrument.ink, fontVariant: ["tabular-nums"], fontWeight: "700" }}>{formatTime(minute)}</AppText>
                        </PressableScale>
                      );
                    })}
                  </View>
                  {editingTime ? (
                    <DateTimePicker
                      mode="time"
                      display={Platform.OS === "ios" ? "spinner" : "default"}
                      value={timeValue(editingTime === "start" ? draft.quiet_start_minute : draft.quiet_end_minute)}
                      onChange={changeTime}
                    />
                  ) : null}

                  <ZoneRule label="Apple Health" />
                  <AppText style={{ color: instrument.mut, fontSize: 13 }}>
                    Raw Apple Health samples stay on this device. Kora receives only the daily totals you enable below, and you can revoke them at any time.
                  </AppText>
                  <HealthToggle label="Share steps" detail="Daily step total" testID="mentor-health-steps" value={draft.health_steps_enabled} onChange={(value) => update("health_steps_enabled", value)} />
                  <HealthToggle label="Share sleep" detail="Daily sleep minutes" testID="mentor-health-sleep" value={draft.health_sleep_enabled} onChange={(value) => update("health_sleep_enabled", value)} />
                  <HealthToggle label="Share workouts" detail="Daily workout minutes" testID="mentor-health-workouts" value={draft.health_workouts_enabled} onChange={(value) => update("health_workouts_enabled", value)} />
                  <HealthToggle label="Share active energy" detail="Daily active energy (kcal)" testID="mentor-health-energy" value={draft.health_energy_enabled} onChange={(value) => update("health_energy_enabled", value)} />
                  <HealthToggle label="Share resting heart rate" detail="Daily resting heart rate (bpm)" testID="mentor-health-heart-rate" value={draft.health_heart_rate_enabled} onChange={(value) => update("health_heart_rate_enabled", value)} />

                  {error ? <AppText accessibilityRole="alert" style={{ color: instrument.danger }}>{error}</AppText> : null}
                  {saved ? <AppText accessibilityRole="alert" style={{ color: instrument.teal }}>Mentor settings saved.</AppText> : null}
                  <Button
                    accessibilityLabel="Save mentor settings"
                    title={putProfile.isPending || deleteHealth.isPending ? "Saving…" : "Save mentor settings"}
                    disabled={putProfile.isPending || deleteHealth.isPending}
                    onPress={() => { void save(); }}
                  />
                </View>
              </BezelCluster>

              <AppText style={[engravedStyle(instrument), { marginTop: spacing.lg, marginBottom: spacing.xs, marginLeft: spacing.md }]}>
                Your commitments
              </AppText>
              <Button
                title="Add a commitment"
                variant="secondary"
                onPress={() => router.push("/mentor-commitment")}
                style={{ marginBottom: spacing.sm }}
              />
              {activeCommitments.length === 0 ? (
                <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.lg }}>
                  <AppText style={{ color: instrument.mut }}>
                    Commitments you accept with Kora will appear here. Nothing becomes a reminder until you confirm it.
                  </AppText>
                </View>
              ) : null}
            </View>
          </>
        )}
        renderItem={({ item, index }) => (
          <View style={{ marginHorizontal: 20 }}>
            {index > 0 ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: instrument.hairline }} /> : null}
            <View style={{ minHeight: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.md, gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <AppText style={{ color: instrument.ink, fontWeight: "600" }}>{item.title}</AppText>
                <AppText style={{ color: instrument.mut, fontSize: 12 }}>{scheduleText(item)}</AppText>
                {item.agent_name ? <AppText style={{ color: instrument.teal, fontSize: 11 }}>{item.agent_name}</AppText> : null}
              </View>
              <Switch
                testID={`mentor-commitment-${item.id}`}
                accessibilityLabel={`${item.title} reminder`}
                value={item.status === "active"}
                onValueChange={(active) => { void toggleCommitment(item, active); }}
                trackColor={{ false: instrument.inset, true: instrument.teal }}
              />
            </View>
          </View>
        )}
      />
    </View>
  );
}
