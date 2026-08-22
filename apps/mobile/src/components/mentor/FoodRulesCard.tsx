import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type {
  MentorDietPattern,
  MentorFoodRule,
  MentorFoodRuleKind,
  MentorFoodSubject,
} from "@/api/types";
import { AppText } from "@/components/Text";
import { ZoneRule } from "@/components/instrument/BezelCluster";
import { engravedStyle } from "@/components/instrument/typography";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";

const PATTERN_LABELS: Record<MentorDietPattern, string> = {
  "": "No pattern",
  vegetarian: "Vegetarian",
  eggetarian: "Eggetarian",
  vegan: "Vegan",
  jain: "Jain",
  halal: "Halal",
  pescatarian: "Pescatarian",
};

const KINDS: { key: MentorFoodRuleKind; label: string; detail: string }[] = [
  { key: "allergy", label: "Allergy", detail: "Never in a plan" },
  { key: "exclusion", label: "Never eat", detail: "Never in a plan" },
  { key: "preference", label: "Prefer not", detail: "Flagged, not blocked" },
];

type Props = {
  pattern: MentorDietPattern;
  patterns: MentorDietPattern[];
  rules: MentorFoodRule[];
  subjects: MentorFoodSubject[];
  onPatternChange: (pattern: MentorDietPattern) => void;
  onAdd: (subject: string, kind: MentorFoodRuleKind) => void;
  onConfirm: (subject: string) => void;
  onRemove: (subject: string) => void;
};

// Chip is the one shape this card uses for every rule, so a proposal and a
// rule in force read as the same object in two states rather than two lists.
function Chip({
  label,
  tone,
  testID,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  tone: "block" | "flag" | "proposed" | "option";
  testID?: string;
  accessibilityLabel?: string;
  onPress?: () => void;
}) {
  const { instrument, spacing } = useTheme();
  const border = tone === "block" ? instrument.accent
    : tone === "proposed" ? instrument.teal
      : instrument.glassBorder;
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={{
        minHeight: 36,
        justifyContent: "center",
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: 999,
        backgroundColor: instrument.inset,
        borderWidth: tone === "block" ? 1 : StyleSheet.hairlineWidth,
        borderColor: border,
      }}
    >
      <AppText style={{ color: instrument.ink, fontSize: 13, fontWeight: "600" }}>{label}</AppText>
    </PressableScale>
  );
}

export function FoodRulesCard({
  pattern,
  patterns,
  rules,
  subjects,
  onPatternChange,
  onAdd,
  onConfirm,
  onRemove,
}: Props) {
  const { instrument, spacing } = useTheme();
  const [adding, setAdding] = useState<MentorFoodRuleKind | null>(null);

  const inForce = rules.filter((rule) => rule.confirmed_at !== null);
  const proposed = rules.filter((rule) => rule.confirmed_at === null);
  const ruled = new Set(rules.map((rule) => rule.subject));
  const available = subjects.filter((subject) => !ruled.has(subject.subject));

  const add = (subject: string): void => {
    if (!adding) return;
    onAdd(subject, adding);
    setAdding(null);
  };

  return (
    <View style={{ gap: spacing.md }} testID="mentor-food-rules">
      <ZoneRule label="Food rules" />
      <AppText style={{ color: instrument.mut, fontSize: 13 }}>
        Kora checks these before it plans a meal. An allergy is never put in a plan; a
        preference is flagged so you can decide.
      </AppText>

      <AppText style={engravedStyle(instrument)}>Diet pattern</AppText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {(["", ...patterns] as MentorDietPattern[]).map((option) => {
          const selected = option === pattern;
          return (
            <PressableScale
              key={option || "none"}
              testID={`mentor-diet-pattern-${option || "none"}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={PATTERN_LABELS[option] ?? option}
              onPress={() => onPatternChange(option)}
              style={{
                minHeight: 40,
                justifyContent: "center",
                paddingHorizontal: spacing.md,
                borderRadius: 999,
                backgroundColor: selected ? instrument.ink : instrument.inset,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: instrument.glassBorder,
              }}
            >
              <AppText style={{ color: selected ? instrument.bg : instrument.mut, fontWeight: "600", fontSize: 13 }}>
                {PATTERN_LABELS[option] ?? option}
              </AppText>
            </PressableScale>
          );
        })}
      </View>

      {proposed.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <AppText style={engravedStyle(instrument)}>Kora noticed</AppText>
          <AppText style={{ color: instrument.mut, fontSize: 12 }}>
            Tap to put one in force. Until you do, it changes nothing.
          </AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {proposed.map((rule) => (
              <Chip
                key={rule.id}
                testID={`mentor-food-rule-proposed-${rule.subject}`}
                label={rule.label}
                tone="proposed"
                accessibilityLabel={`Confirm ${rule.label}`}
                onPress={() => onConfirm(rule.subject)}
              />
            ))}
          </View>
        </View>
      ) : null}

      <AppText style={engravedStyle(instrument)}>In force</AppText>
      {inForce.length === 0 ? (
        <AppText style={{ color: instrument.mut, fontSize: 13 }}>
          No rules yet. Add an allergy or a food you never eat.
        </AppText>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {inForce.map((rule) => (
            <Chip
              key={rule.id}
              testID={`mentor-food-rule-${rule.subject}`}
              label={rule.severity === "block" ? `${rule.label} · never` : rule.label}
              tone={rule.severity === "block" ? "block" : "flag"}
              accessibilityLabel={`Remove ${rule.label}`}
              onPress={() => onRemove(rule.subject)}
            />
          ))}
        </View>
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {KINDS.map((kind) => (
          <PressableScale
            key={kind.key}
            testID={`mentor-food-rule-add-${kind.key}`}
            accessibilityRole="button"
            accessibilityState={{ selected: adding === kind.key }}
            accessibilityLabel={`Add a ${kind.label.toLowerCase()} rule`}
            onPress={() => setAdding(adding === kind.key ? null : kind.key)}
            style={{
              minHeight: 40,
              justifyContent: "center",
              paddingHorizontal: spacing.md,
              borderRadius: 12,
              backgroundColor: adding === kind.key ? instrument.ink : instrument.inset,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: instrument.glassBorder,
            }}
          >
            <AppText style={{ color: adding === kind.key ? instrument.bg : instrument.ink, fontWeight: "600", fontSize: 13 }}>
              + {kind.label}
            </AppText>
          </PressableScale>
        ))}
      </View>

      {adding ? (
        <View style={{ gap: spacing.sm }} testID="mentor-food-rule-picker">
          <AppText style={{ color: instrument.mut, fontSize: 12 }}>
            {KINDS.find((kind) => kind.key === adding)?.detail}
          </AppText>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
            {available.map((subject) => (
              <Chip
                key={subject.subject}
                testID={`mentor-food-subject-${subject.subject}`}
                label={subject.label}
                tone="option"
                onPress={() => add(subject.subject)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
