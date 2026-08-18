import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCoachAsk, useCoachNudges, useCoachThread } from "@/api/hooks";
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
  const ask = useCoachAsk();
  const [input, setInput] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [askError, setAskError] = useState(false);

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
      onSuccess: () => {
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
              <Bubble key={`${turn.created_at}-${turn.role}-${index}`} role={turn.role} text={turn.text} citations={turn.citations} />
            ))
          )}
          {pendingQuestion ? <Bubble role="user" text={pendingQuestion} /> : null}
          {pendingQuestion && !askError ? <Bubble role="otto" text="Otto is thinking…" /> : null}
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
