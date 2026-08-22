import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { INSTRUMENT_DARK_FIXED } from "@/theme";
import { withAlpha } from "@/lib/color";
import type { MealPlanDay, MealPlanProposal } from "@/api/types";

// Capture is exempt from theming — camera surfaces are always dark — so every
// colour comes from the fixed dark tokens, never from useTheme().instrument.
const T = INSTRUMENT_DARK_FIXED;

interface Props {
  plan: MealPlanProposal;
  onApprove: () => void;
  approving?: boolean;
}

// The origin is fixed in code and only the meal name is interpolated, so a
// model-supplied name can steer the search terms but never the destination.
function openPreparationSearch(mealName: string) {
  const query = encodeURIComponent(`${mealName} recipe`);
  void Linking.openURL(`https://www.youtube.com/results?search_query=${query}`).catch(() => {});
}

function DaySection({ day, isLast }: { day: MealPlanDay; isLast: boolean }) {
  return (
    <View
      style={{
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: withAlpha(T.glassBorder, 0.6),
      }}
    >
      {day.date ? (
        <AppText
          style={{
            fontSize: 10,
            fontWeight: "700",
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: T.mut,
            marginBottom: 6,
          }}
        >
          {day.date}
        </AppText>
      ) : null}
      <View style={{ gap: 6 }}>
        {day.meals.map((meal, index) => (
          <View key={index} style={{ flexDirection: "row", gap: 8 }}>
            <AppText style={{ color: T.mut, fontSize: 14, lineHeight: 20 }}>·</AppText>
            <View style={{ flexShrink: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <AppText
                  style={{
                    flexShrink: 1,
                    color: T.ink,
                    fontSize: 14,
                    lineHeight: 20,
                    fontWeight: "600",
                  }}
                >
                  {meal.name}
                </AppText>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Find preparation video for ${meal.name}`}
                  onPress={() => openPreparationSearch(meal.name)}
                  style={(state) => ({
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 44,
                    minWidth: 44,
                    opacity: state.pressed ? 0.6 : 1,
                  })}
                >
                  <Icon name="search" size={13} color={T.mut} />
                </Pressable>
              </View>
              {meal.description ? (
                <AppText style={{ color: T.mut, fontSize: 12, lineHeight: 18 }}>
                  {meal.description}
                </AppText>
              ) : null}
              {meal.preparation ? (
                <View style={{ flexDirection: "row", gap: 6, marginTop: 3 }}>
                  <AppText
                    maxFontSizeMultiplier={1.5}
                    style={{
                      fontSize: 10,
                      fontWeight: "700",
                      letterSpacing: 1.2,
                      textTransform: "uppercase",
                      color: withAlpha(T.mut, 0.75),
                      lineHeight: 18,
                    }}
                  >
                    How
                  </AppText>
                  <AppText style={{ flexShrink: 1, color: T.mut, fontSize: 12, lineHeight: 18 }}>
                    {meal.preparation}
                  </AppText>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// The plan the coach reviewed, as the thing it is rather than a paragraph the
// user has to re-read to act on. One recessed well per plan, days as engraved
// zone rules, and a single accent action — the screen's one hero moment while
// a plan is on it.
//
// Approval activates reminders but never writes meals into the diary; logging
// remains an explicit user action.
// formatStartsOn renders the server's local calendar date without letting the
// device's zone shift it a day: the date was already resolved in the user's
// own zone at approval, so it is read as calendar parts, not as an instant.
function formatStartsOn(startsOn: string | null): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(startsOn ?? "");
  if (!parts) return "";
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  return date.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function PlanCard({ plan, onApprove, approving = false }: Props) {
  const approved = plan.accepted_at !== null;
  const startsOn = formatStartsOn(plan.starts_on ?? null);
  return (
    <View
      testID="plan-card"
      style={{
        marginLeft: 40,
        backgroundColor: T.inset,
        borderWidth: 1,
        borderColor: T.glassBorder,
        borderRadius: 18,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="sparkles" size={14} color={T.mut} />
        <AppText
          style={{
            flexShrink: 1,
            fontSize: 10,
            fontWeight: "700",
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: T.mut,
          }}
        >
          {`${plan.agent_name} · reviewed by ${plan.reviewed_by}`}
        </AppText>
      </View>

      {plan.summary ? (
        <AppText style={{ color: T.ink, fontSize: 14, lineHeight: 21, marginTop: 8 }}>
          {plan.summary}
        </AppText>
      ) : null}

      <View style={{ marginTop: 4 }}>
        {plan.days.map((day, index) => (
          <DaySection key={index} day={day} isLast={index === plan.days.length - 1} />
        ))}
      </View>

      {approved ? (
        <View
          testID="plan-card-approved"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 44,
            borderRadius: 14,
            marginTop: 4,
            backgroundColor: withAlpha(T.teal, 0.14),
            borderWidth: 1,
            borderColor: withAlpha(T.teal, 0.4),
          }}
        >
          <Icon name="check" size={16} color={T.teal} />
          <AppText style={{ color: T.teal, fontSize: 13, fontWeight: "700" }}>
            {startsOn ? `Plan approved · starts ${startsOn}` : "Plan approved"}
          </AppText>
        </View>
      ) : (
        <Pressable
          testID="plan-card-approve"
          accessibilityRole="button"
          accessibilityLabel={approving ? "Approving plan" : "Approve this plan"}
          accessibilityState={{ disabled: approving }}
          disabled={approving}
          onPress={onApprove}
          style={(state) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 44,
            borderRadius: 14,
            marginTop: 4,
            backgroundColor: T.accent,
            opacity: state.pressed ? 0.85 : 1,
          })}
        >
          {approving ? (
            <ActivityIndicator testID="plan-card-approving-spinner" color={T.accentOn} />
          ) : (
            <>
              <Icon name="check" size={16} color={T.accentOn} />
              <AppText style={{ color: T.accentOn, fontSize: 13, fontWeight: "700" }}>
                Approve this plan
              </AppText>
            </>
          )}
        </Pressable>
      )}

      <AppText style={{ color: T.mut, fontSize: 11, lineHeight: 16, marginTop: 8 }}>
        Approving activates daily plan reminders at your first enabled meal reminder time. Nothing is logged — tell Otto what to change any time.
      </AppText>
    </View>
  );
}
