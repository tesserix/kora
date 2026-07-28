import { ActivityIndicator, Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { GaugeRing } from "@/components/GaugeRing";
import { foodVisual } from "@/lib/foodVisual";
import { withAlpha } from "@/lib/color";
import type { MealSlot } from "@/lib/mealSlot";
import { kcalTotalLabel } from "@/lib/resolutionKcal";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import { useTheme } from "@/theme";
import { captureColors } from "./captureTheme";
import { ModePill } from "./ModePill";

// A UI-only reference scale for the header GaugeRing's fill proportion — not
// a nutrition claim or a goal, just a sensible upper bound so a single-item
// snack and a multi-item feast both read as a legible arc. Never rendered as
// text (that's always kcalTotalLabel's verbatim/summed string, see below).
const RING_DISPLAY_MAX_KCAL = 1200;

// The ring's *fill proportion* only — mirrors kcalTotalLabel's own rule
// (sum candidate kcal, or the estimate range) so the arc always agrees with
// the verbatim/summed total already shown as text. Never itself rendered as
// a new text label — only fed to GaugeRing's numeric `value` prop.
function kcalTotalValue(resolution: Resolution): number {
  if (resolution.is_estimate) {
    return ((resolution.kcal_low ?? 0) + (resolution.kcal_high ?? 0)) / 2;
  }
  return resolution.candidates.reduce((total, candidate) => total + candidate.kcal, 0);
}

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

// A small colored pill for one of the food item's own per-100g macro
// values — rendered verbatim (only Math.round'd for display, the same
// treatment already applied to kcal/portion/match above) straight from the
// FoodItem the server resolved. Never scaled by portion — that would be a
// derived nutrition number this card doesn't sanction.
function MacroChip({ label, per100g, tint }: { label: string; per100g: number; tint: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 9999,
        backgroundColor: withAlpha(tint, 0.18),
      }}
    >
      <AppText style={{ fontSize: 10, fontWeight: "700", color: tint }}>
        {`${label} ${Math.round(per100g)}g/100g`}
      </AppText>
    </View>
  );
}

function CandidateRow({ candidate, isLast }: { candidate: ResolvedCandidate; isLast: boolean }) {
  const { icon } = foodVisual(candidate.item.name);
  const { gradients } = useTheme();
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
          backgroundColor: captureColors.tileBg,
        }}
      >
        <Icon name={icon} size={18} color={captureColors.tileFg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ color: captureColors.onSurface, fontSize: 14, fontWeight: "600" }}>
          {candidate.item.name}
        </AppText>
        <AppText style={{ color: captureColors.onSurfaceFaint, fontSize: 11 }}>
          {`${Math.round(candidate.portion_grams)}g · ${Math.round(candidate.match_score * 100)}% match`}
        </AppText>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
          <MacroChip label="P" per100g={candidate.item.protein_per_100g} tint={gradients.green[0]} />
          <MacroChip label="C" per100g={candidate.item.carbs_per_100g} tint={gradients.amber[0]} />
          <MacroChip label="F" per100g={candidate.item.fat_per_100g} tint={gradients.blue[0]} />
        </View>
      </View>
      <AppText style={{ flexShrink: 0, color: captureColors.onSurface, fontSize: 13, fontWeight: "700" }}>
        {`${Math.round(candidate.kcal)} kcal`}
      </AppText>
    </View>
  );
}

// The AI-capture result card — detected items, the running total (echoed by
// a decorative GaugeRing), a meal-slot selector, and the confirm action.
// Renders every number verbatim from the Resolution the server returned; the
// only client-side math is the kcal sum used when the resolution is not an
// estimate (kcalTotalLabel/kcalTotalValue) and the ring's own fill fraction.
// The per-candidate macro chips render the FoodItem's own per-100g fields
// verbatim (never scaled by portion) — see MacroChip above.
export function DetectedCard({ resolution, mealSlot, onChangeMealSlot, onAdd, adding }: Props) {
  const { gradients } = useTheme();
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <View style={{ flex: 1, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
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
            {kcalTotalLabel(resolution)}
          </AppText>
        </View>
        <GaugeRing
          value={kcalTotalValue(resolution)}
          max={RING_DISPLAY_MAX_KCAL}
          size={40}
          stroke={4}
          gradient={gradients.green}
        >
          <Icon name="flame" size={14} color={captureColors.primary} />
        </GaugeRing>
      </View>

      {resolution.candidates.map((candidate, i) => (
        <CandidateRow
          key={`${candidate.item.id}-${i}`}
          candidate={candidate}
          isLast={i === resolution.candidates.length - 1}
        />
      ))}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
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
