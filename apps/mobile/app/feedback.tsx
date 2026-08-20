import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { safeBack } from "@/lib/safeBack";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedGlass } from "@/components/instrument/SegmentedGlass";
import { Button } from "@/components/Button";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { AppText } from "@/components/Text";
import { useSubmitFeedback } from "@/api/hooks";
import { deviceContext } from "@/lib/deviceContext";
import { useTheme } from "@/theme";
import type { FeedbackKind } from "@/api/types";

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 4000;
// Only nudge the user once they're close to the cap — not a permanent counter.
const DESCRIPTION_HINT_THRESHOLD = 200;

// Kept to one word each (kora#294). A segmented control divides one track into
// N equal parts, so each label gets half the width; at accessibility-extra-large
// on a 440pt screen "Something's broken" needed 344.8pt against a 196.7pt
// half-track, and would only fit shrunk to 15.1pt — 52% of the size the user
// asked for. Wrapping could not save it either: "SOMETHING'S" alone needed
// 212.9pt, more than the whole half-track before the second word.
//
// #288 had already spent the layout levers (the gutter went 6.7 -> 23.0pt) and
// #263 ruled out flexShrink, which splits words rather than fitting them. What
// was left was the copy. iOS's own UISegmentedControl sidesteps this by not
// participating in Dynamic Type at all — Apple can do that because Apple also
// controls every label's length; here, controlling the length is the fix.
//
// `key` is the API contract and does not change with the label.
const KIND_OPTIONS: { key: FeedbackKind; label: string }[] = [
  { key: "bug", label: "Bug" },
  { key: "feature", label: "Idea" },
];

function descriptionPlaceholder(kind: FeedbackKind): string {
  return kind === "bug"
    ? "What happened, and what did you expect instead?"
    : "What would you like to see, and why would it help?";
}

function errorMessageFor(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Couldn't send that. Please try again.";
}

export default function Feedback() {
  const insets = useSafeAreaInsets();
  const { instrument, spacing, radius } = useTheme();
  const submitFeedback = useSubmitFeedback();

  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const trimmedSubject = subject.trim();
  const trimmedDescription = description.trim();
  const canSubmit = trimmedSubject.length > 0 && trimmedDescription.length > 0 && !submitFeedback.isPending;
  const descriptionRemaining = DESCRIPTION_MAX - description.length;
  const showDescriptionHint = descriptionRemaining <= DESCRIPTION_HINT_THRESHOLD;

  const onChangeKind = (key: string): void => setKind(key as FeedbackKind);

  const onSubmit = (): void => {
    if (!canSubmit) return;
    setErrorMessage(null);
    submitFeedback.mutate(
      {
        kind,
        subject: trimmedSubject,
        description: trimmedDescription,
        ...deviceContext(),
      },
      {
        onSuccess: () => setSubmitted(true),
        onError: (error: unknown) => setErrorMessage(errorMessageFor(error)),
      },
    );
  };

  const inputStyle = {
    fontSize: 16,
    color: instrument.ink,
    backgroundColor: instrument.inset,
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: instrument.bg }}>
      <AppBackground />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenHeader overline="Help us improve" title="Send feedback" onBack={() => safeBack("/(tabs)/more")} />
          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            {submitted ? (
              <GlassPanel radius={22} style={{ padding: spacing.md, gap: spacing.sm, alignItems: "flex-start" }}>
                <AppText style={{ fontSize: 22, fontWeight: "700", color: instrument.ink }}>Thanks — got it.</AppText>
                <AppText variant="subheadline" style={{ color: instrument.mut }}>
                  We read every note. If yours needs a reply, we'll be in touch.
                </AppText>
                <Button
                  title="Done"
                  accessibilityLabel="Done"
                  onPress={() => router.back()}
                  style={{ alignSelf: "stretch", marginTop: spacing.sm }}
                />
              </GlassPanel>
            ) : (
              <>
                <SegmentedGlass options={KIND_OPTIONS} value={kind} onChange={onChangeKind} />

                <TextInput
                  value={subject}
                  onChangeText={setSubject}
                  maxLength={SUBJECT_MAX}
                  placeholder="What's it about?"
                  placeholderTextColor={instrument.mut}
                  accessibilityLabel="Subject"
                  style={inputStyle}
                />

                <View>
                  <TextInput
                    value={description}
                    onChangeText={setDescription}
                    maxLength={DESCRIPTION_MAX}
                    multiline
                    textAlignVertical="top"
                    placeholder={descriptionPlaceholder(kind)}
                    placeholderTextColor={instrument.mut}
                    accessibilityLabel="Description"
                    style={[inputStyle, { minHeight: 140 }]}
                  />
                  {showDescriptionHint ? (
                    <AppText style={{ fontSize: 13, color: instrument.mut, marginTop: spacing.sm }}>
                      {descriptionRemaining} characters left
                    </AppText>
                  ) : null}
                </View>

                {errorMessage ? (
                  <AppText style={{ color: instrument.danger }}>{errorMessage}</AppText>
                ) : null}

                <Button
                  title={submitFeedback.isPending ? "Sending…" : "Send"}
                  accessibilityLabel="Send"
                  disabled={!canSubmit}
                  onPress={onSubmit}
                  style={{ borderRadius: 22 }}
                />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
