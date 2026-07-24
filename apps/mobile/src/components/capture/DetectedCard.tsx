import { ActivityIndicator, Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { foodVisual } from "@/lib/foodVisual";
import { tileBg, tileFg } from "@/lib/hue";
import type { MealSlot } from "@/lib/mealSlot";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import { captureColors } from "./captureTheme";
import { ModePill } from "./ModePill";

interface Props {
  resolution: Resolution;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
}

const MEAL_SLOTS: ReadonlyArray<{ slot: MealSlot; label: string; icon: string }> = [
  { slot: "breakfast", label: "Breakfast", icon: "coffee" },
  { slot: "lunch", label: "Lunch", icon: "utensils" },
  { slot: "dinner", label: "Dinner", icon: "utensils" },
  { slot: "snack", label: "Snack", icon: "apple" },
];

function totalLabel(resolution: Resolution): string {
  if (resolution.is_estimate) {
    const low = Math.round(resolution.kcal_low ?? 0);
    const high = Math.round(resolution.kcal_high ?? 0);
    return `${low}–${high} kcal`;
  }
  const sum = resolution.candidates.reduce((total, candidate) => total + candidate.kcal, 0);
  return `${Math.round(sum)} kcal`;
}

function CandidateRow({ candidate, isLast }: { candidate: ResolvedCandidate; isLast: boolean }) {
  const { hue, icon } = foodVisual(candidate.item.name);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        paddingVertical: 8,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: captureColors.cardDivider,
      }}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          backgroundColor: tileBg(hue),
        }}
      >
        <Icon name={icon} size={18} color={tileFg(hue)} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={{ color: captureColors.onSurface, fontSize: 14, fontWeight: "600" }}>
          {candidate.item.name}
        </AppText>
        <AppText style={{ color: captureColors.onSurfaceFaint, fontSize: 11 }}>
          {`${Math.round(candidate.portion_grams)}g · ${Math.round(candidate.match_score * 100)}% match`}
        </AppText>
      </View>
      <AppText style={{ color: captureColors.onSurface, fontSize: 13, fontWeight: "700" }}>
        {Math.round(candidate.kcal)}
      </AppText>
    </View>
  );
}

// The AI-capture result card — detected items, the running total, a meal-slot
// selector, and the confirm action. Renders every number verbatim from the
// Resolution the server returned; the only client-side math is the kcal sum
// used when the resolution is not an estimate.
export function DetectedCard({ resolution, mealSlot, onChangeMealSlot, onAdd, adding }: Props) {
  return (
    <View
      style={{
        backgroundColor: captureColors.cardBg,
        borderWidth: 1,
        borderColor: captureColors.cardBorder,
        borderRadius: 16,
        padding: 14,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <AppText
          style={{
            fontSize: 12,
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: 1,
            color: captureColors.onSurfaceMuted,
          }}
        >
          {`Detected · ${resolution.candidates.length} items`}
        </AppText>
        <AppText style={{ fontSize: 14, fontWeight: "700", color: captureColors.onSurface }}>
          {totalLabel(resolution)}
        </AppText>
      </View>

      {resolution.candidates.map((candidate, i) => (
        <CandidateRow
          key={`${candidate.item.id}-${i}`}
          candidate={candidate}
          isLast={i === resolution.candidates.length - 1}
        />
      ))}

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        {MEAL_SLOTS.map(({ slot, label, icon }) => (
          <ModePill key={slot} icon={icon} label={label} active={mealSlot === slot} onPress={() => onChangeMealSlot(slot)} />
        ))}
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={adding ? "Adding to diary" : "Add to diary"}
          accessibilityState={{ disabled: adding }}
          disabled={adding}
          onPress={onAdd}
          style={(state) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 44,
            borderRadius: 12,
            backgroundColor: captureColors.primary,
            opacity: state.pressed ? 0.85 : 1,
          })}
        >
          {adding ? (
            <ActivityIndicator testID="detected-card-adding-spinner" color={captureColors.primaryForeground} />
          ) : (
            <>
              <Icon name="check" size={16} color={captureColors.primaryForeground} />
              <AppText style={{ color: captureColors.primaryForeground, fontSize: 15, fontWeight: "600" }}>
                Add to diary
              </AppText>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}
