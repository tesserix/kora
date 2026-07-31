import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { AppBackground } from "@/components/AppBackground";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Segmented } from "@/components/Segmented";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { AppText } from "@/components/Text";
import { useSubmitFeedback } from "@/api/hooks";
import { deviceContext } from "@/lib/deviceContext";
import { useTheme } from "@/theme";
import type { FeedbackKind } from "@/api/types";

const SUBJECT_MAX = 200;
const DESCRIPTION_MAX = 4000;
// Only nudge the user once they're close to the cap — not a permanent counter.
const DESCRIPTION_HINT_THRESHOLD = 200;

const KIND_OPTIONS: { key: FeedbackKind; label: string }[] = [
  { key: "bug", label: "Something's broken" },
  { key: "feature", label: "I have an idea" },
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
  const { colors, spacing, radius } = useTheme();
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
    color: colors.label,
    backgroundColor: colors.cardSecondary,
    borderRadius: radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
  } as const;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppBackground />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenHeader title="Send feedback" onBack={() => router.back()} />
          <View style={{ paddingHorizontal: 20, gap: spacing.lg }}>
            {submitted ? (
              <Card variant="elevated" style={{ gap: spacing.sm, alignItems: "flex-start" }}>
                <AppText variant="title2">Thanks — got it.</AppText>
                <AppText muted>We read every note. If yours needs a reply, we'll be in touch.</AppText>
                <Button
                  title="Done"
                  accessibilityLabel="Done"
                  onPress={() => router.back()}
                  style={{ alignSelf: "stretch", marginTop: spacing.sm }}
                />
              </Card>
            ) : (
              <>
                <Segmented options={KIND_OPTIONS} value={kind} onChange={onChangeKind} />

                <TextInput
                  value={subject}
                  onChangeText={setSubject}
                  maxLength={SUBJECT_MAX}
                  placeholder="What's it about?"
                  placeholderTextColor={colors.secondaryLabel}
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
                    placeholderTextColor={colors.secondaryLabel}
                    accessibilityLabel="Description"
                    style={[inputStyle, { minHeight: 140 }]}
                  />
                  {showDescriptionHint ? (
                    <AppText variant="footnote" muted style={{ marginTop: spacing.xs }}>
                      {descriptionRemaining} characters left
                    </AppText>
                  ) : null}
                </View>

                {errorMessage ? (
                  <AppText style={{ color: colors.destructive }}>{errorMessage}</AppText>
                ) : null}

                <Button
                  title={submitFeedback.isPending ? "Sending…" : "Send"}
                  accessibilityLabel="Send"
                  disabled={!canSubmit}
                  onPress={onSubmit}
                />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
