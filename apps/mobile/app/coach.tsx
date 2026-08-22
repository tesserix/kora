import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import type { MentorCommitmentProposal } from "@/api/types";
import { useAIPacks, useAIUsage, useCoachAsk, useCoachNudges, useCoachThread } from "@/api/hooks";
import { aiAllowance } from "@/api/aiUsage";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AppText } from "@/components/Text";
import { AskInput } from "@/components/coach/AskInput";
import { Bubble } from "@/components/coach/Bubble";
import { FocusCard } from "@/components/coach/FocusCard";
import { SuggestionChips } from "@/components/coach/SuggestionChips";
import { SupportCard } from "@/components/coach/SupportCard";
import { BezelCluster, ZoneRule } from "@/components/instrument/BezelCluster";
import { safeBack } from "@/lib/safeBack";
import { PressableScale } from "@/motion";
import { useIsOnline } from "@/offline/connectivity";
import { useTheme } from "@/theme";

// DEFAULT_AGENT names the capability Kora routes every coach question to, so
// the thinking line reads honestly before any agent has identified itself.
const DEFAULT_AGENT = "Coach";

function reviewProposal(proposal: MentorCommitmentProposal): void {
  router.push({
    pathname: "/mentor-commitment",
    params: {
      proposalId: proposal.id,
      title: proposal.title,
      kind: proposal.kind,
      cadence: proposal.cadence,
      weekdaysMask: String(proposal.weekdays_mask),
      startMinute: String(proposal.start_minute),
      intervalMinutes: proposal.interval_minutes === null ? "" : String(proposal.interval_minutes),
      endMinute: proposal.end_minute === null ? "" : String(proposal.end_minute),
      timezone: proposal.timezone,
      startsOn: proposal.starts_on.slice(0, 10),
      endsOn: proposal.ends_on?.slice(0, 10) ?? "",
    },
  });
}

function InlineRetry({ message, label, onPress }: { message: string; label: string; onPress: () => void }) {
  const { instrument } = useTheme();
  return (
    <View style={{ alignItems: "flex-start", gap: 2, marginBottom: 12 }}>
      <AppText style={{ color: instrument.mut, fontSize: 13 }}>{message}</AppText>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={label}
        haptic="none"
        onPress={onPress}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Retry</AppText>
      </PressableScale>
    </View>
  );
}

export default function CoachScreen() {
  const { instrument, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useIsOnline();
  const nudges = useCoachNudges();
  const thread = useCoachThread();
  const usage = useAIUsage();
  // Otto still answers when the allowance is gone — it just answers that it
  // cannot. The offer to top up belongs next to that reply, not three screens
  // away in More.
  const packs = useAIPacks();
  const outOfRequests = (usage.data ? aiAllowance(usage.data).blocked : false) && (packs.data?.length ?? 0) > 0;
  const ask = useCoachAsk();
  const [input, setInput] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [askError, setAskError] = useState(false);
  // Who answered last. The thinking line names the agent before the answer
  // lands, so it starts at the capability Kora routes Q&A to and is corrected
  // to the published name once an agent has actually replied.
  const [activeAgent, setActiveAgent] = useState(DEFAULT_AGENT);

  const focus = nudges.data?.nudges ?? [];
  const turns = thread.data?.turns ?? [];
  const showSupport = nudges.data?.show_support === true || thread.data?.show_support === true;

  const send = (provided?: string) => {
    const question = (provided ?? input).trim();
    if (!question || !online || ask.isPending) return;
    setInput(question);
    setPendingQuestion(question);
    setAskError(false);
    ask.mutate(question, {
      onSuccess: (answer) => {
        setActiveAgent(answer.agent?.name ?? DEFAULT_AGENT);
        setInput("");
        setPendingQuestion(null);
        setAskError(false);
      },
      onError: () => setAskError(true),
    });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: instrument.bg }}
    >
      <AppBackground />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: spacing.lg }}
      >
        <ScreenHeader overline="Grounded in your logs" title="Coach" onBack={() => safeBack("/(tabs)")} />
        <View style={{ paddingHorizontal: 20 }}>
          {nudges.isLoading && !nudges.data ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: spacing.md }}>
              <ActivityIndicator color={instrument.accent} />
              <AppText style={{ color: instrument.mut }}>Refreshing today&apos;s focus…</AppText>
            </View>
          ) : null}
          {nudges.isError ? (
            <InlineRetry message="Couldn't refresh today's focus." label="Retry focus" onPress={() => void nudges.refetch()} />
          ) : null}

          {showSupport || focus.length > 0 ? (
            <BezelCluster testID="coach-focus-cluster" style={{ marginBottom: spacing.lg }}>
              {showSupport ? <SupportCard /> : null}
              {focus.length > 0 ? (
                <>
                  <ZoneRule label="Today's focus" />
                  {focus.map((nudge, index) => (
                    <FocusCard key={`${nudge.kind}-${nudge.title}`} nudge={nudge} last={index === focus.length - 1} />
                  ))}
                </>
              ) : null}
            </BezelCluster>
          ) : null}

          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <AppText style={{ color: instrument.ink, fontSize: 15, fontWeight: "700" }}>Conversation</AppText>
            <View style={{ height: 1, flex: 1, backgroundColor: instrument.hairline }} />
          </View>

          {thread.isLoading && !thread.data ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: spacing.md }}>
              <ActivityIndicator color={instrument.mut} />
              <AppText style={{ color: instrument.mut }}>Loading your conversation…</AppText>
            </View>
          ) : null}
          {thread.isError ? (
            <InlineRetry
              message="I couldn't load your earlier conversation. You can still ask a new question."
              label="Retry conversation"
              onPress={() => void thread.refetch()}
            />
          ) : null}
          {turns.length === 0 ? (
            <Bubble role="otto" text="Hi — ask me about the nutrition you’ve logged, and I’ll stick to the facts in your Kora data." />
          ) : (
            turns.map((turn, index) => (
              <Bubble
                key={`${turn.created_at}-${turn.role}-${index}`}
                role={turn.role}
                text={turn.text}
                citations={turn.citations}
                agent={turn.agent}
                proposal={turn.proposal}
                onReviewProposal={reviewProposal}
              />
            ))
          )}
          {pendingQuestion ? <Bubble role="user" text={pendingQuestion} /> : null}
          {pendingQuestion && !askError ? (
            <Bubble role="otto" text={`${activeAgent} is thinking…`} agent={activeAgent} />
          ) : null}
          {pendingQuestion && askError ? (
            <View style={{ marginBottom: 12 }}>
              <Bubble role="otto" text="Couldn't get an answer. Your question is still here." />
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Retry question"
                haptic="selection"
                onPress={() => send(pendingQuestion)}
                style={{ minHeight: 44, alignSelf: "flex-start", justifyContent: "center" }}
              >
                <AppText style={{ color: instrument.accent, fontWeight: "700" }}>Try again</AppText>
              </PressableScale>
            </View>
          ) : null}

          {outOfRequests ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                marginBottom: 12,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 14,
                backgroundColor: instrument.inset,
              }}
            >
              <AppText style={{ flex: 1, color: instrument.mut, fontSize: 12 }}>
                Your AI allowance is spent. It resets on its own — or add requests now.
              </AppText>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Add requests"
                haptic="selection"
                onPress={() => router.push("/ai-top-up")}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  borderRadius: 12,
                  backgroundColor: instrument.accent,
                }}
              >
                <AppText style={{ color: instrument.accentOn, fontWeight: "700" }}>Add requests</AppText>
              </PressableScale>
            </View>
          ) : null}

          <SuggestionChips disabled={!online || ask.isPending} onSelect={(question) => send(question)} />
          {!online ? (
            <AppText accessibilityLiveRegion="polite" style={{ color: instrument.mut, fontSize: 12, marginTop: 10 }}>
              You&apos;re offline — reconnect to ask Otto.
            </AppText>
          ) : null}
        </View>
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: instrument.bg }}>
        <AskInput
          value={input}
          disabled={!online}
          pending={ask.isPending}
          onChangeText={setInput}
          onSend={() => send()}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
