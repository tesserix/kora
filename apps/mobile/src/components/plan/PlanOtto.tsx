import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { usePlanOtto } from "@/api/hooks";
import type {
  PlanChange,
  PlanChangeField,
  PlanOttoProposal,
} from "@/api/types";
import { AppText } from "@/components/Text";
import { AskInput } from "@/components/coach/AskInput";
import { Bubble } from "@/components/coach/Bubble";
import { SupportCard } from "@/components/coach/SupportCard";
import { monoStyle } from "@/components/instrument/typography";
import { PressableScale } from "@/motion";
import {
  draftFromParams,
  draftToParams,
  type PlanDraft,
} from "@/lib/planDraft";
import { useTheme } from "@/theme";
import {
  ACTIVITY_IDS,
  ACTIVITY_LABELS,
  GOAL_IDS,
  GOAL_LABELS,
} from "../../../app/onboarding";

export const PLAN_CHANGE_LABEL: Record<PlanChangeField, string> = {
  activity_level: "Activity",
  goal: "Goal",
  goal_weight_kg: "Goal weight",
  pace_kg_per_week: "Pace",
  kcal: "Calories",
  protein_g: "Protein",
  carbs_g: "Carbs",
  fat_g: "Fat",
};

const UNIT: Partial<Record<PlanChangeField, string>> = {
  goal_weight_kg: "kg",
  pace_kg_per_week: "kg/wk",
  kcal: "kcal",
  protein_g: "g",
  carbs_g: "g",
  fat_g: "g",
};

const BUDGET_COPY =
  "You've used your Otto allowance for now. You can still edit the numbers directly.";
const FAILED_COPY =
  "Otto couldn't answer. You can still edit the numbers directly.";

type Exchange = {
  you: string;
  reply: string;
  proposal: PlanOttoProposal | null;
  showSupport: boolean;
  // The draft the proposal was built from; applying it to any other draft
  // would silently undo the user's later edits.
  basis: string;
};

// Same round-trip plan.tsx gives server data: nulls become absent, and
// anything draftFromParams wouldn't accept from a deep link is refused.
function proposedDraft(p: PlanOttoProposal): PlanDraft | null {
  return draftFromParams(draftToParams(p.draft as PlanDraft));
}

function enumLabel(
  ids: readonly string[],
  labels: readonly string[],
  v: string | number,
) {
  return labels[ids.indexOf(String(v))] ?? String(v);
}

function changeText({ field, from, to }: PlanChange): string {
  if (field === "activity_level")
    return `${enumLabel(ACTIVITY_IDS, ACTIVITY_LABELS, from)} → ${enumLabel(ACTIVITY_IDS, ACTIVITY_LABELS, to)}`;
  if (field === "goal")
    return `${enumLabel(GOAL_IDS, GOAL_LABELS, from)} → ${enumLabel(GOAL_IDS, GOAL_LABELS, to)}`;
  return `${from} → ${to} ${UNIT[field]}`;
}

export function PlanOtto({
  draft,
  onUse,
}: {
  draft: PlanDraft;
  onUse: (draft: PlanDraft) => void;
}) {
  const { instrument, spacing, fonts } = useTheme();
  const otto = usePlanOtto();
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [offered, setOffered] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function send() {
    const message = input.trim();
    if (!message || otto.isPending) return;
    const basis = JSON.stringify(draft);
    setPending(message);
    setError(null);
    setOffered(false);
    otto.mutate(
      { message, draft },
      {
        onSuccess: (res) => {
          const valid = res.proposal && proposedDraft(res.proposal) !== null;
          setExchanges((xs) => [
            ...xs,
            {
              you: message,
              reply: res.reply,
              proposal: valid ? res.proposal : null,
              showSupport: res.show_support,
              basis,
            },
          ]);
          setOffered(!!valid);
          if (res.proposal && !valid) setError(FAILED_COPY);
          setInput("");
          setPending(null);
        },
        onError: (e) => {
          setPending(null);
          setError(
            (e as { status?: unknown }).status === 429
              ? BUDGET_COPY
              : FAILED_COPY,
          );
        },
      },
    );
  }

  const last = exchanges.length - 1;
  const current = JSON.stringify(draft);
  const textButton = {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
  } as const;
  const buttonText = {
    fontSize: 13,
    fontWeight: "600",
    color: instrument.ink,
  } as const;

  return (
    <View testID="plan-otto">
      {exchanges.map((x, i) => (
        <View key={i}>
          <Bubble role="user" text={x.you} />
          <Bubble role="otto" text={x.reply} />
          {x.showSupport ? <SupportCard /> : null}
          {i === last && offered && x.proposal && x.basis === current ? (
            <View
              style={{
                marginBottom: 12,
                padding: 12,
                gap: 6,
                borderRadius: 14,
                backgroundColor: instrument.inset,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: instrument.glassBorder,
              }}
            >
              {x.proposal.changes.map((c) => (
                <View
                  key={c.field}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                  }}
                >
                  <AppText style={{ color: instrument.mut, fontSize: 13 }}>
                    {PLAN_CHANGE_LABEL[c.field]}
                  </AppText>
                  <AppText
                    style={[
                      monoStyle(fonts),
                      { color: instrument.ink, fontSize: 13 },
                    ]}
                  >
                    {changeText(c)}
                  </AppText>
                </View>
              ))}
              <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
                <PressableScale
                  accessibilityRole="button"
                  haptic="none"
                  onPress={() => setOffered(false)}
                  style={textButton}
                >
                  <AppText style={[buttonText, { color: instrument.mut }]}>
                    Not now
                  </AppText>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  haptic="selection"
                  onPress={() => {
                    const next = proposedDraft(x.proposal!);
                    setOffered(false);
                    if (next) onUse(next);
                  }}
                  style={textButton}
                >
                  <AppText style={buttonText}>Use this</AppText>
                </PressableScale>
              </View>
            </View>
          ) : null}
        </View>
      ))}
      {pending ? <Bubble role="user" text={pending} /> : null}
      {error ? (
        <AppText
          accessibilityRole="alert"
          style={{ color: instrument.mut, fontSize: 13, marginBottom: 12 }}
        >
          {error}
        </AppText>
      ) : null}
      <AskInput
        ink
        value={input}
        disabled={false}
        pending={otto.isPending}
        onChangeText={setInput}
        onSend={send}
      />
      <AppText
        variant="footnote"
        muted
        style={{ textAlign: "center", marginTop: spacing.xs }}
      >
        Otto is AI and can be wrong. Kora checks every number before it&apos;s
        used.
      </AppText>
    </View>
  );
}
