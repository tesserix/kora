import { useEffect, useState, type ReactElement } from "react";
import { ActivityIndicator, TextInput, View } from "react-native";
import { Sheet } from "@/components/Sheet";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { Overline } from "@/components/Overline";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { useResolveText } from "@/api/hooks";
import type { FoodItem, Resolution, ResolvedCandidate } from "@/api/types";
import { foodVisual } from "@/lib/foodVisual";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

export interface AskAgainSheetProps {
  visible: boolean;
  /** The phrase to prefill the editable input with — the log's own input_phrase. */
  phrase: string;
  onSelect: (item: FoodItem) => void;
  /** Bail out to the free index search (FoodPicker) instead of spending another AI call. */
  onManualSearch: () => void;
  onClose: () => void;
}

// One re-resolved candidate row. Presentation mirrors FoodPicker's own result
// rows (FoodTile-style icon via foodVisual, name, a secondary detail line,
// kcal on the trailing edge) rather than reusing capture's DetectedCard —
// DetectedCard is wired to the capture flow's meal-slot pills and its own
// "Add to diary" action, and bending it to a second caller here would mean
// carrying props it never needs. kcal and portion_grams are rendered
// verbatim from the server's ResolvedCandidate; nothing here is recomputed.
function CandidateRow({ candidate, onPress }: { candidate: ResolvedCandidate; onPress: () => void }): ReactElement {
  const { colors } = useTheme();
  const vis = foodVisual(candidate.item.name);
  return (
    <PressableScale
      haptic="selection"
      accessibilityRole="button"
      accessibilityLabel={`Select ${candidate.item.name}`}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.cardSecondary,
        }}
      >
        <Icon name={vis.icon} size={18} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="headline">{candidate.item.name}</AppText>
        <AppText variant="footnote" muted>
          {`${Math.round(candidate.portion_grams)}g · ${Math.round(candidate.match_score * 100)}% match`}
        </AppText>
      </View>
      <AppText variant="subheadline" muted>{`${Math.round(candidate.kcal)} kcal`}</AppText>
    </PressableScale>
  );
}

// The opt-in escalation from Task 3's free-index FoodPicker: this one spends
// a real AI call, so it never fires automatically — only on an explicit
// submit of a phrase the user can edit first. Every number shown for a
// resolved candidate comes verbatim from the server's ResolvedCandidate.
export function AskAgainSheet({ visible, phrase, onSelect, onManualSearch, onClose }: AskAgainSheetProps): ReactElement {
  const { colors, spacing, fontSize } = useTheme();
  const [text, setText] = useState(phrase);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolveText = useResolveText();

  // Reset to the log's phrase (and clear any prior result/error) every time
  // the sheet opens, rather than leaking a previous visit's edit or result.
  useEffect(() => {
    if (visible) {
      setText(phrase);
      setResolution(null);
      setError(null);
    }
  }, [visible, phrase]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || resolveText.isPending) return;
    setError(null);
    setResolution(null);
    resolveText.mutate(trimmed, {
      onSuccess: (result: Resolution) => setResolution(result),
      onError: () => setError("Couldn't ask Kora right now. Try again."),
    });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 30 }}>
        <Overline style={{ marginTop: 8, marginBottom: 8 }}>Ask Kora again</Overline>

        <Card variant="elevated" style={{ padding: 0, marginBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md }}>
            <TextInput
              accessibilityLabel="Describe what you ate"
              style={{ flex: 1, color: colors.label, fontSize: fontSize.base, paddingVertical: 12 }}
              placeholder="What did you eat?"
              placeholderTextColor={colors.secondaryLabel}
              autoFocus
              value={text}
              onChangeText={setText}
            />
          </View>
        </Card>

        <Button
          title={resolveText.isPending ? "Asking Kora…" : "Ask Kora"}
          accessibilityLabel="Submit phrase to Kora"
          disabled={!text.trim() || resolveText.isPending}
          onPress={submit}
          style={{ marginBottom: 14 }}
        />

        {resolveText.isPending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}>
            <ActivityIndicator color={colors.accent} />
            <AppText variant="footnote" muted>
              Asking Kora — this costs a real AI call.
            </AppText>
          </View>
        ) : null}

        {error ? (
          <AppText variant="footnote" style={{ color: colors.destructive, marginTop: 4 }}>
            {error}
          </AppText>
        ) : null}

        {resolution && resolution.tier === "follow_up" ? (
          <View>
            <AppText variant="subheadline" style={{ marginTop: 4, marginBottom: 12 }}>
              {resolution.follow_up_question}
            </AppText>
            <Button
              title="Search manually instead"
              variant="secondary"
              accessibilityLabel="Search manually instead"
              onPress={onManualSearch}
            />
          </View>
        ) : null}

        {resolution && resolution.tier !== "follow_up" && resolution.candidates.length === 0 ? (
          <View>
            <AppText variant="subheadline" muted style={{ marginTop: 4, marginBottom: 12 }}>
              Kora couldn't identify that.
            </AppText>
            <Button
              title="Search manually instead"
              variant="secondary"
              accessibilityLabel="Search manually instead"
              onPress={onManualSearch}
            />
          </View>
        ) : null}

        {resolution && resolution.tier !== "follow_up" && resolution.candidates.length > 0 ? (
          <View>
            {resolution.candidates.map((candidate, i) => (
              <CandidateRow key={`${candidate.item.id}-${i}`} candidate={candidate} onPress={() => onSelect(candidate.item)} />
            ))}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}
