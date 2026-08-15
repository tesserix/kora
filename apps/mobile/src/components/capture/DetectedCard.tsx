import { ActivityIndicator, Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { SubDial } from "@/components/instrument/SubDial";
import { formatPortion, portionEntryFor } from "@/units/portion";
import { foodVisual } from "@/lib/foodVisual";
import type { MealSlot } from "@/lib/mealSlot";
import { kcalTotalLabel } from "@/lib/resolutionKcal";
import { contributesKcal, isUncertain, loggableCandidates } from "@/lib/candidateTier";
import type { Resolution, ResolvedCandidate } from "@/api/types";
import { useTheme, INSTRUMENT_DARK_FIXED } from "@/theme";
import { ModePill } from "./ModePill";
import { monoStyle } from "@/components/instrument/typography";

// Instrument Glass, dark-fixed. Capture is exempt from theming (spec: "Dark
// capture screen is exempt from theming: camera surfaces are always dark"),
// so every color here comes from the INSTRUMENT_DARK_FIXED constant — never
// from useTheme().instrument, which would follow the device's light/dark
// scheme and go light.
const T = INSTRUMENT_DARK_FIXED;

// A UI-only reference scale for the header SubDial's fill proportion — not
// a nutrition claim or a goal, just a sensible upper bound so a single-item
// snack and a multi-item feast both read as a legible arc. Never rendered as
// text (that's always kcalTotalLabel's verbatim/summed string, see below).
const RING_DISPLAY_MAX_KCAL = 1200;

// The ring's *fill proportion* only — mirrors kcalTotalLabel's own rule
// (sum candidate kcal, or the estimate range) so the arc always agrees with
// the verbatim/summed total already shown as text. Never itself rendered as
// a new text label — only fed to SubDial's numeric `fraction` prop.
function kcalTotalValue(resolution: Resolution): number {
  if (resolution.is_estimate) {
    return ((resolution.kcal_low ?? 0) + (resolution.kcal_high ?? 0)) / 2;
  }
  return resolution.candidates
    .filter(contributesKcal)
    .reduce((total, candidate) => total + candidate.kcal, 0);
}

interface Props {
  resolution: Resolution;
  mealSlot: MealSlot;
  onChangeMealSlot: (slot: MealSlot) => void;
  onAdd: () => void;
  adding: boolean;
  /**
   * Asked when the user taps an uncertain row, with that row's index in
   * `resolution.candidates`. When absent the row still reads as uncertain but
   * is not pressable — the card never resolves anything on its own.
   */
  onResolveUncertain?: (index: number) => void;
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
// Neutral instrument styling — P/C/F are distinguished by their label, not by
// decorative per-macro hues (the accent rule reserves orange for the CTA and
// header flame, and the spec bans new green/purple as data-series color).
function MacroChip({ label, per100g }: { label: string; per100g: number }) {
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 9999,
        backgroundColor: T.inset,
      }}
    >
      <AppText style={{ fontSize: 10, fontWeight: "700", color: T.mut }}>
        {`${label} ${Math.round(per100g)}g/100g`}
      </AppText>
    </View>
  );
}

function CandidateRow({
  candidate,
  isLast,
  onResolve,
}: {
  candidate: ResolvedCandidate;
  isLast: boolean;
  onResolve?: () => void;
}) {
  const { icon } = foodVisual(candidate.item.name);
  const { fonts } = useTheme();
  const mono = monoStyle(fonts);
  // Uncertainty is a presentation concern here and nothing else — an uncertain
  // row is preselected and logged like any other, it just has to keep reading
  // as a guess.
  const uncertain = isUncertain(candidate);
  // Withholding the number is a SEPARATE condition: only a row the user picked
  // by hand has no server kcal yet (kcal_unknown), and only it renders "—".
  // Keying this off `uncertain` instead would blank the server's own kcal on a
  // preselected row, and print a fabricated "0 kcal" for a hand-picked one.
  const showsKcal = contributesKcal(candidate);

  const body = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        paddingVertical: 8,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: T.hairline,
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
          backgroundColor: T.inset,
        }}
      >
        <Icon name={uncertain ? "help-circle" : icon} size={18} color={T.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText style={{ color: T.ink, fontSize: 15, fontWeight: "600" }}>
          {candidate.item.name}
        </AppText>
        {/* The confident row keeps its portion but no longer states a raw
            match percentage — that number was false precision about a score
            the user cannot act on. The weak row states the same portion plus
            where it came from and what to do about it, because it is about to
            be logged on the user's behalf unless they intervene. */}
        <AppText style={[{ color: T.mut, fontSize: 11 }, mono]}>
          {uncertain
            ? `${formatPortion(portionEntryFor(candidate.portion_grams, candidate.item.base_unit, candidate.item.serving_units))} · Best guess — tap to change`
            : formatPortion(portionEntryFor(candidate.portion_grams, candidate.item.base_unit, candidate.item.serving_units))}
        </AppText>
        {candidate.portion_assumed ? (
          // The server had no serving size for this food and estimated the
          // portion instead. That estimate must never read like a measurement
          // — engraved, `mut`, no accent (this is information, not an alarm).
          <AppText
            style={{
              color: T.mut,
              fontSize: 9,
              fontWeight: "700",
              textTransform: "uppercase",
              letterSpacing: 1,
              marginTop: 2,
            }}
          >
            portion is a guess
          </AppText>
        ) : null}
        {uncertain ? null : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
            <MacroChip label="P" per100g={candidate.item.protein_per_100g} />
            <MacroChip label="C" per100g={candidate.item.carbs_per_100g} />
            <MacroChip label="F" per100g={candidate.item.fat_per_100g} />
          </View>
        )}
      </View>
      <AppText
        style={[
          {
            flexShrink: 0,
            color: showsKcal ? T.ink : T.mut,
            fontSize: 13,
            fontWeight: "700",
          },
          mono,
        ]}
      >
        {showsKcal ? `${Math.round(candidate.kcal)} kcal` : "—"}
      </AppText>
    </View>
  );

  if (!uncertain || !onResolve) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Change ${candidate.item.name}`}
      onPress={onResolve}
      style={(state) => ({ opacity: state.pressed ? 0.6 : 1 })}
    >
      {body}
    </Pressable>
  );
}

// The AI-capture result card — detected items, the running total (echoed by
// a decorative SubDial), a meal-slot selector, and the confirm action.
// Renders every number verbatim from the Resolution the server returned; the
// only client-side math is the kcal sum used when the resolution is not an
// estimate (kcalTotalLabel/kcalTotalValue) and the ring's own fill fraction.
// The per-candidate macro chips render the FoodItem's own per-100g fields
// verbatim (never scaled by portion) — see MacroChip above.
//
// Instrument Glass, dark-fixed panel (`T` = INSTRUMENT_DARK_FIXED, see top of
// file) — a `GlassPanel`-style dark glass fill rather than the component
// itself, since GlassPanel reads useTheme().instrument (scheme-aware) and
// this card must stay dark even when the device is in light mode.
export function DetectedCard({
  resolution,
  mealSlot,
  onChangeMealSlot,
  onAdd,
  adding,
  onResolveUncertain,
}: Props) {
  const { fonts } = useTheme();
  const mono = monoStyle(fonts);
  // The CTA states what will actually be written to the diary. Every detected
  // row is written — the uncertain ones as the server's preselected top match
  // — so this now agrees with the header count; the guard below only survives
  // for a resolution with no candidates at all.
  const loggable = loggableCandidates(resolution);
  const nothingToLog = loggable.length === 0;
  const ctaLabel = `Add ${loggable.length} item${loggable.length === 1 ? "" : "s"} to diary`;
  return (
    <View
      testID="detected-card"
      style={{
        backgroundColor: T.glass,
        borderWidth: 1,
        borderColor: T.glassBorder,
        borderRadius: 20,
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
              letterSpacing: 1.4,
              color: T.mut,
            }}
          >
            {`Detected · ${resolution.candidates.length} items`}
          </AppText>
          <AppText style={[{ fontSize: 14, fontWeight: "700", color: T.ink }, mono]}>
            {kcalTotalLabel(resolution)}
          </AppText>
        </View>
        <View style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
          <SubDial
            testID="detected-card-ring"
            fraction={kcalTotalValue(resolution) / RING_DISPLAY_MAX_KCAL}
            size={40}
            tokens={T}
          />
          <View style={{ position: "absolute" }}>
            <Icon name="flame" size={14} color={T.accent} />
          </View>
        </View>
      </View>

      {resolution.candidates.map((candidate, i) => (
        <CandidateRow
          key={`${candidate.item.id}-${i}`}
          candidate={candidate}
          isLast={i === resolution.candidates.length - 1}
          onResolve={onResolveUncertain ? () => onResolveUncertain(i) : undefined}
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
          accessibilityState={{ disabled: adding || nothingToLog }}
          disabled={adding || nothingToLog}
          onPress={onAdd}
          style={(state) => ({
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            minHeight: 44,
            borderRadius: 18,
            backgroundColor: T.accent,
            opacity: state.pressed ? 0.85 : 1,
          })}
        >
          {adding ? (
            <ActivityIndicator testID="detected-card-adding-spinner" color={T.accentOn} />
          ) : (
            <>
              <Icon name="check" size={16} color={T.accentOn} />
              <AppText style={{ color: T.accentOn, fontSize: 13, fontWeight: "700" }}>
                {ctaLabel}
              </AppText>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}
