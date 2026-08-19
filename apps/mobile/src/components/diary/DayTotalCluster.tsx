import { useEffect } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { BezelCluster, WellFooter } from "@/components/instrument/BezelCluster";
import { engravedStyle, monoStyle } from "@/components/instrument/typography";
import { PressableScale, useMotionPrefs } from "@/motion";
import { useTheme } from "@/theme";
import { flOzToMl, type UnitSystem } from "@/units";

export type WaterQuickAdd = { ml: number; label: string; a11yLabel: string };

// Quick-add amounts per unit system. Metric: 250/500 ml. Imperial: a cup (8 fl oz)
// and a large glass (16 fl oz), stored as their rounded ml equivalents (the backend
// is always ml). Metric labels/a11y are preserved verbatim for existing tests.
export const WATER_QUICK_ADDS: Record<UnitSystem, readonly WaterQuickAdd[]> = {
  metric: [
    { ml: 250, label: "+250 ml", a11yLabel: "Add 250 ml water" },
    { ml: 500, label: "+500 ml", a11yLabel: "Add 500 ml water" },
  ],
  imperial: [
    { ml: Math.round(flOzToMl(8)), label: "+8 fl oz", a11yLabel: "Add 8 fl oz water" },
    { ml: Math.round(flOzToMl(16)), label: "+16 fl oz", a11yLabel: "Add 16 fl oz water" },
  ],
};

type WaterPillProps = {
  label: string;
  a11yLabel: string;
  disabled: boolean;
  stacked: boolean;
  onPress: () => void;
};

// Above this text scale the two pills no longer fit side by side and the row
// stacks (kora#173). Chosen against the label they have to hold: at the 1.6
// ceiling below, "+250 ml" needs roughly 110pt, and a half-width pill in this
// footer only offers ~85pt. 1.3 is the first Dynamic Type step where that gap
// opens, and it is a THRESHOLD not a cap — the type keeps growing past it, the
// pills just stop competing for the same line.
const STACK_FONT_SCALE = 1.3;

// The established ceiling for primary controls in this app (FloatingTabBar,
// GaugeDial, WeekRail, ModePill all use 1.6).
const PILL_MAX_FONT_MULTIPLIER = 1.6;

// The WellFooter's recessed inset pill (spec Step 3: "restyled as inset
// pills") — same instrument.inset fill + glassBorder ring the well itself is
// carved from, so the buttons read as part of the recess rather than sitting
// on top of it.
function WaterPill({ label, a11yLabel, disabled, stacked, onPress }: WaterPillProps) {
  const { instrument } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled }}
      haptic="impactLight"
      disabled={disabled}
      onPress={onPress}
      style={{
        // Stacked, each pill already spans the row's full width (the column's
        // default align-items: stretch); flex: 1 there would instead divide a
        // height nothing has asked for.
        ...(stacked ? null : { flex: 1 }),
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 13,
        borderRadius: 16,
        backgroundColor: instrument.inset,
        borderWidth: 1,
        borderColor: instrument.glassBorder,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {/* numberOfLines={1} is the hard guarantee, not a nicety: wrapped, this
          label breaks mid-number and the control MISSTATES ITS OWN QUANTITY —
          at accessibility-extra-large "+250 ml" read as "+25" / "0 ml" while
          still adding 250 (kora#173). The cap and the stacking above are what
          keep the one line legible rather than merely atomic; nothing here is
          allowed to shrink the glyphs, so a quantity that still cannot fit
          would truncate visibly instead of lying quietly. */}
      <AppText
        numberOfLines={1}
        maxFontSizeMultiplier={PILL_MAX_FONT_MULTIPLIER}
        style={{ color: instrument.ink, fontWeight: "700" }}
      >
        {label}
      </AppText>
    </PressableScale>
  );
}

const TRACK_ANIM_MS = 1100;

interface DayTotalTrackProps {
  pct: number;
}

// Diary's ONE accent moment (spec: accent budget) — the 6px day-total track
// animates its width in on mount and on every day change (~1100ms ease-out),
// collapsing to an instant snap under Reduce Motion rather than losing the
// motion outright.
function DayTotalTrack({ pct }: DayTotalTrackProps) {
  const { instrument } = useTheme();
  const { reduceMotion } = useMotionPrefs();
  const width = useSharedValue(pct);

  useEffect(() => {
    if (reduceMotion) {
      width.value = pct;
    } else {
      width.value = withTiming(pct, { duration: TRACK_ANIM_MS, easing: Easing.out(Easing.ease) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pct, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ width: `${width.value}%` }));

  return (
    <View
      testID="day-total-track"
      style={{ height: 6, borderRadius: 3, backgroundColor: instrument.inset, overflow: "hidden", marginTop: 10 }}
    >
      <Animated.View style={[{ height: "100%", backgroundColor: instrument.accent, borderRadius: 3 }, animatedStyle]} />
    </View>
  );
}

export interface DayTotalClusterProps {
  testID?: string;
  unknownTotals: boolean;
  dashError: boolean;
  total: number;
  goal: number;
  pct: number;
  waterLabel: string;
  waterQuickAdds: readonly WaterQuickAdd[];
  addWaterDisabled: boolean;
  onAddWater: (ml: number) => void;
  waterErr: string | null;
  destructiveColor: string;
}

// The day's single BezelCluster (spec Step 3): engraved total + mono figure +
// animated accent track, then a WellFooter carrying the water readout and
// quick-add pills. Meal log rows live OUTSIDE this cluster entirely (Step 4,
// in diary.tsx) — this component owns only the day-total zone.
export function DayTotalCluster({
  testID,
  unknownTotals,
  dashError,
  total,
  goal,
  pct,
  waterLabel,
  waterQuickAdds,
  addWaterDisabled,
  onAddWater,
  waterErr,
  destructiveColor,
}: DayTotalClusterProps) {
  const { instrument, fonts } = useTheme();
  const mono = monoStyle(fonts);
  // useWindowDimensions, not PixelRatio.getFontScale(): the former is reactive,
  // so the footer relays out when the user changes their text size and returns
  // to a still-mounted app (same reason AppleSignInButton uses it).
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > STACK_FONT_SCALE;

  return (
    <View>
      <BezelCluster radius={26} testID={testID}>
        <View style={{ padding: 16 }}>
          <AppText maxFontSizeMultiplier={1.4} style={engravedStyle(instrument)}>Day total</AppText>
          {unknownTotals ? (
            <AppText style={[{ fontSize: 22, color: instrument.mut, marginTop: 4 }, mono]}>—</AppText>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 4 }}>
              <AppText style={[{ fontSize: 17, fontWeight: "600", color: instrument.ink }, mono]}>{total}</AppText>
              <AppText style={[{ fontSize: 13, color: instrument.mut }, mono]}>{` / ${Math.round(goal).toLocaleString()} kcal`}</AppText>
            </View>
          )}
          {/* Hidden outright on error, the way Home hides its gauge: an empty
              track is still a claim — "0% of your goal" — about a day we
              could not load. */}
          {dashError ? null : <DayTotalTrack pct={pct} />}
        </View>

        <WellFooter>
          <View>
            <AppText maxFontSizeMultiplier={1.4} style={{ fontSize: 11, color: instrument.mut }}>Water</AppText>
            {/* The sibling readout the pills sit beside, and a quantity for the
                same reason they are: "0.0 L" wrapping to "0.0" / "L" would put
                a bare unit on its own line under a bare number. */}
            <AppText
              numberOfLines={1}
              maxFontSizeMultiplier={PILL_MAX_FONT_MULTIPLIER}
              style={[{ fontSize: 15, fontWeight: "600", color: instrument.ink, marginTop: 2 }, mono]}
            >
              {waterLabel}
            </AppText>
          </View>
          <View
            style={{
              flexDirection: stacked ? "column" : "row",
              gap: 8,
              flex: 1,
              marginLeft: 16,
            }}
          >
            {waterQuickAdds.map((qa) => (
              <WaterPill
                key={qa.ml}
                label={qa.label}
                a11yLabel={qa.a11yLabel}
                disabled={addWaterDisabled}
                stacked={stacked}
                onPress={() => onAddWater(qa.ml)}
              />
            ))}
          </View>
        </WellFooter>
      </BezelCluster>
      {waterErr ? (
        // Announced, not just drawn: this is the only signal the tap failed,
        // and it is the same live-region treatment the other inline errors in
        // the app already use.
        <AppText accessibilityLiveRegion="polite" style={{ color: destructiveColor, marginTop: 8 }}>
          {waterErr}
        </AppText>
      ) : null}
    </View>
  );
}
