import { StyleSheet, View } from "react-native";
import type { CoachCitation, CoachRole, MentorCommitmentProposal } from "@/api/types";
import { AppText } from "@/components/Text";
import { PressableScale } from "@/motion";
import { useTheme } from "@/theme";
import { CitationChips } from "./CitationChips";

export function Bubble({
  role,
  text,
  citations = [],
  agent,
  proposal,
  onReviewProposal,
}: {
  role: CoachRole;
  text: string;
  citations?: CoachCitation[];
  agent?: string;
  proposal?: MentorCommitmentProposal;
  onReviewProposal?: (proposal: MentorCommitmentProposal) => void;
}) {
  const { instrument } = useTheme();
  const user = role === "user";
  // Engraved byline, same micro-label idiom as ZoneRule: the agent is named
  // beside Otto so the user can see which specialist actually answered.
  const byline = !user && agent ? `Otto · ${agent}` : null;
  const speaker = byline ?? (user ? "You" : "Otto");
  return (
    <View style={{ alignItems: user ? "flex-end" : "flex-start", marginBottom: 12 }}>
      {byline ? (
        <AppText
          maxFontSizeMultiplier={1.4}
          style={{
            fontSize: 10,
            fontWeight: "600",
            letterSpacing: 1.5,
            color: instrument.mut,
            marginBottom: 5,
            marginLeft: 4,
          }}
        >
          {byline.toUpperCase()}
        </AppText>
      ) : null}
      <View
        accessibilityLabel={`${speaker}: ${text}`}
        style={{
          maxWidth: "86%",
          borderRadius: 18,
          borderBottomRightRadius: user ? 6 : 18,
          borderBottomLeftRadius: user ? 18 : 6,
          paddingHorizontal: 14,
          paddingVertical: 11,
          backgroundColor: user ? instrument.inset : instrument.glass,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: user ? instrument.tick : instrument.glassBorder,
        }}
      >
        <AppText style={{ color: instrument.ink, fontSize: 15, lineHeight: 21 }}>{text}</AppText>
      </View>
      {!user ? <CitationChips citations={citations} /> : null}
      {!user && proposal ? (
        <View
          style={{
            width: "86%",
            marginTop: 8,
            padding: 12,
            gap: 6,
            borderRadius: 14,
            backgroundColor: instrument.inset,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: instrument.glassBorder,
          }}
        >
          <AppText style={{ color: instrument.mut, fontSize: 11 }}>
            Suggested by {proposal.agent_name} · reviewed by {proposal.reviewed_by}
          </AppText>
          <AppText style={{ color: instrument.ink, fontSize: 15, fontWeight: "700" }}>{proposal.title}</AppText>
          {proposal.accepted_commitment_id ? (
            <AppText style={{ color: instrument.teal, fontSize: 13, fontWeight: "600" }}>Commitment active</AppText>
          ) : (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Review suggested commitment"
              haptic="selection"
              onPress={() => onReviewProposal?.(proposal)}
              style={{ minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: instrument.ink }}
            >
              <AppText style={{ color: instrument.bg, fontWeight: "700" }}>Review & activate</AppText>
            </PressableScale>
          )}
        </View>
      ) : null}
    </View>
  );
}
