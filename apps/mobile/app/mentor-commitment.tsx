import { useState } from "react";
import { Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MentorCommitmentCadence, MentorCommitmentKind } from "@/api/types";
import { useAcceptMentorProposal, usePutMentorCommitment } from "@/api/hooks";
import { localDateNow } from "@/lib/localDate";
import { safeBack } from "@/lib/safeBack";
import { AppBackground } from "@/components/AppBackground";
import { Button } from "@/components/Button";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { ensureNotificationAccess, openNotificationSettings } from "@/reminders/notificationAccess";

const KINDS: { key: MentorCommitmentKind; label: string }[] = [
  { key: "hydration", label: "Water" },
  { key: "walking", label: "Walk" },
  { key: "meal", label: "Meal" },
  { key: "custom", label: "Other" },
];
const CADENCES: { key: MentorCommitmentCadence; label: string }[] = [
  { key: "fixed", label: "Fixed time" },
  { key: "interval", label: "Interval" },
];
const INTERVALS = [60, 120, 180];
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

type ProposalDraft = {
  proposalId: string;
  title: string;
  kind: MentorCommitmentKind;
  cadence: MentorCommitmentCadence;
  weekdaysMask: number;
  startMinute: number;
  intervalMinutes: number | null;
  endMinute: number | null;
  timezone: string;
  startsOn: string;
  endsOn: string | null;
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function routeProposal(params: Record<string, string | string[] | undefined>): ProposalDraft | null {
  const proposalId = first(params.proposalId);
  const title = first(params.title).trim();
  const kind = first(params.kind);
  const cadence = first(params.cadence);
  const weekdaysMask = Number(first(params.weekdaysMask));
  const startMinute = Number(first(params.startMinute));
  const rawInterval = first(params.intervalMinutes);
  const rawEnd = first(params.endMinute);
  const intervalMinutes = rawInterval === "" ? null : Number(rawInterval);
  const endMinute = rawEnd === "" ? null : Number(rawEnd);
  const timezone = first(params.timezone);
  const startsOn = first(params.startsOn);
  const endsOn = first(params.endsOn) || null;
  if (!proposalId || proposalId.length > 100 || !title || title.length > 120) return null;
  if (!KINDS.some((option) => option.key === kind) || !CADENCES.some((option) => option.key === cadence)) return null;
  if (!Number.isInteger(weekdaysMask) || weekdaysMask < 1 || weekdaysMask > 127) return null;
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) return null;
  if (!timezone || timezone.length > 64 || !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) return null;
  if (endsOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) return null;
  if (endsOn !== null && endsOn < startsOn) return null;
  if (cadence === "fixed" && (intervalMinutes !== null || endMinute !== null)) return null;
  if (cadence === "interval" && (
    !Number.isInteger(intervalMinutes) || intervalMinutes! < 30 || intervalMinutes! > 720
    || !Number.isInteger(endMinute) || endMinute! <= startMinute || endMinute! > 1439
  )) return null;
  return {
    proposalId, title, kind: kind as MentorCommitmentKind,
    cadence: cadence as MentorCommitmentCadence, weekdaysMask, startMinute,
    intervalMinutes, endMinute, timezone, startsOn, endsOn,
  };
}

function minuteDate(minute: number): Date {
  return new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
}

function formatTime(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { instrument } = useTheme();
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      haptic="selection"
      style={{
        minHeight: 44,
        flex: 1,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected ? instrument.ink : instrument.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? instrument.ink : instrument.glassBorder,
      }}
    >
      <AppText style={{ color: selected ? instrument.bg : instrument.mut, fontWeight: "600" }}>{label}</AppText>
    </PressableScale>
  );
}

export default function MentorCommitmentScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const proposal = routeProposal(params);
  const putCommitment = usePutMentorCommitment();
  const acceptProposal = useAcceptMentorProposal();
  const [title, setTitle] = useState(proposal?.title ?? "");
  const [kind, setKind] = useState<MentorCommitmentKind>(proposal?.kind ?? "custom");
  const [cadence, setCadence] = useState<MentorCommitmentCadence>(proposal?.cadence ?? "fixed");
  const [startMinute, setStartMinute] = useState(proposal?.startMinute ?? 8 * 60);
  const [endMinute, setEndMinute] = useState(proposal?.endMinute ?? 20 * 60);
  const [intervalMinutes, setIntervalMinutes] = useState(proposal?.intervalMinutes ?? 120);
  const [weekdaysMask, setWeekdaysMask] = useState(proposal?.weekdaysMask ?? 127);
  const [editingTime, setEditingTime] = useState<"start" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const intervalOptions = Array.from(new Set([intervalMinutes, ...INTERVALS])).sort((a, b) => a - b);

  const chooseTime = (event: DateTimePickerEvent, value?: Date): void => {
    if (Platform.OS !== "ios" || event.type === "dismissed") setEditingTime(null);
    if (!value || event.type === "dismissed" || !editingTime) return;
    const minute = value.getHours() * 60 + value.getMinutes();
    if (editingTime === "start") setStartMinute(minute);
    else setEndMinute(minute);
  };

  const toggleDay = (day: number): void => {
    setWeekdaysMask((current) => current ^ (1 << day));
  };

  const activate = async (): Promise<void> => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("Name this commitment first.");
      return;
    }
    if (weekdaysMask === 0) {
      setError("Choose at least one day.");
      return;
    }
    if (cadence === "interval" && endMinute <= startMinute) {
      setError("The interval end time must be after its start.");
      return;
    }
    setError(null);
    setNotificationsBlocked(false);
    try {
      const access = await ensureNotificationAccess().catch(() => ({ granted: false, blocked: false }));
      const commitmentID = randomUUID();
      const input = {
        title: cleanTitle,
        kind,
        cadence,
        weekdays_mask: weekdaysMask,
        start_minute: startMinute,
        interval_minutes: cadence === "interval" ? intervalMinutes : null,
        end_minute: cadence === "interval" ? endMinute : null,
        timezone: proposal?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
        starts_on: proposal?.startsOn ?? localDateNow(),
        ends_on: proposal?.endsOn ?? null,
      };
      if (proposal) {
        await acceptProposal.mutateAsync({
          proposalId: proposal.proposalId,
          commitmentId: commitmentID,
          ...input,
        });
      } else {
        await putCommitment.mutateAsync({ id: commitmentID, ...input, status: "active" });
      }
      if (access.granted) router.replace("/mentor");
      else setNotificationsBlocked(true);
    } catch {
      setError("This commitment could not be activated. Please try again.");
    }
  };

  const inputStyle = {
    minHeight: 48,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    color: instrument.ink,
    backgroundColor: instrument.inset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: instrument.glassBorder,
    fontSize: 15,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 80 }} keyboardShouldPersistTaps="handled">
        <ScreenHeader
          overline={proposal ? "Coach suggestion" : "User-approved reminder"}
          title={proposal ? "Review commitment" : "New commitment"}
          onBack={() => safeBack(proposal ? "/coach" : "/mentor")}
        />
        <View style={{ paddingHorizontal: 20 }}>
          <BezelCluster radius={26}>
            <View style={{ padding: spacing.md, gap: spacing.md }}>
              <AppText style={{ color: instrument.mut }}>
                {proposal
                  ? "Review this agent suggestion and adjust anything you need. It stays inactive until you press Activate."
                  : "Add a commitment you and Kora agreed on. It stays inactive until you press Activate."}
              </AppText>
              <TextInput
                accessibilityLabel="Commitment title"
                placeholder="e.g. Drink water"
                placeholderTextColor={instrument.mut}
                value={title}
                onChangeText={setTitle}
                maxLength={120}
                style={inputStyle}
              />

              <ZoneRule label="Type" />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {KINDS.map((option) => (
                  <View key={option.key} style={{ width: "48%" }}>
                    <Choice label={option.label} selected={kind === option.key} onPress={() => setKind(option.key)} />
                  </View>
                ))}
              </View>

              <ZoneRule label="Schedule" />
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                {CADENCES.map((option) => (
                  <Choice key={option.key} label={option.label} selected={cadence === option.key} onPress={() => setCadence(option.key)} />
                ))}
              </View>
              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <Button title={`Start ${formatTime(startMinute)}`} variant="secondary" style={{ flex: 1 }} onPress={() => setEditingTime("start")} />
                {cadence === "interval" ? (
                  <Button title={`End ${formatTime(endMinute)}`} variant="secondary" style={{ flex: 1 }} onPress={() => setEditingTime("end")} />
                ) : null}
              </View>
              {editingTime ? (
                <DateTimePicker
                  mode="time"
                  display={Platform.OS === "ios" ? "spinner" : "default"}
                  value={minuteDate(editingTime === "start" ? startMinute : endMinute)}
                  onChange={chooseTime}
                />
              ) : null}

              {cadence === "interval" ? (
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  {intervalOptions.map((minutes) => (
                    <PressableScale
                      key={minutes}
                      accessibilityRole="button"
                      accessibilityLabel={`Every ${minutes} minutes`}
                      onPress={() => setIntervalMinutes(minutes)}
                      haptic="selection"
                      style={{
                        flex: 1,
                        minHeight: 44,
                        borderRadius: 12,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: intervalMinutes === minutes ? instrument.ink : instrument.inset,
                      }}
                    >
                      <AppText style={{ color: intervalMinutes === minutes ? instrument.bg : instrument.mut }}>
                        {minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`}
                      </AppText>
                    </PressableScale>
                  ))}
                </View>
              ) : null}

              <AppText style={{ color: instrument.mut, fontSize: 12 }}>Days</AppText>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                {DAYS.map((label, day) => {
                  const selected = (weekdaysMask & (1 << day)) !== 0;
                  return (
                    <PressableScale
                      key={day}
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Day ${day + 1}`}
                      accessibilityState={{ checked: selected }}
                      onPress={() => toggleDay(day)}
                      haptic="selection"
                      style={{
                        width: 40,
                        height: 44,
                        borderRadius: 20,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: selected ? instrument.ink : instrument.inset,
                      }}
                    >
                      <AppText style={{ color: selected ? instrument.bg : instrument.mut, fontWeight: "700" }}>{label}</AppText>
                    </PressableScale>
                  );
                })}
              </View>

              {error ? <AppText accessibilityRole="alert" style={{ color: instrument.danger }}>{error}</AppText> : null}
              {notificationsBlocked ? (
                <View style={{ gap: spacing.xs }}>
                  <AppText accessibilityRole="alert" style={{ color: instrument.mut }}>
                    Your commitment is active, but notifications are off. You can still check it in Kora.
                  </AppText>
                  <Button title="Open notification settings" variant="secondary" onPress={() => { void openNotificationSettings(); }} />
                </View>
              ) : null}
              <Button
                accessibilityLabel={proposal ? "Activate suggestion" : "Activate commitment"}
                title={putCommitment.isPending || acceptProposal.isPending
                  ? "Activating…"
                  : proposal ? "Activate suggestion" : "Activate commitment"}
                disabled={putCommitment.isPending || acceptProposal.isPending}
                onPress={() => { void activate(); }}
              />
            </View>
          </BezelCluster>
        </View>
      </ScrollView>
    </View>
  );
}
