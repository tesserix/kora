import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { AppText } from "@/components/Text";
import { useMotionPrefs } from "@/motion";
import { useTheme, type InstrumentTokens } from "@/theme";

export interface EnergyBarsDay {
  label: string;
  fraction: number;
  over: boolean;
  /**
   * No log for this day, or it failed to load — which is NOT the same as a
   * day of zero calories. A zero-height bar states the latter, so a noData
   * slot renders as an empty track instead: the day keeps its position
   * without the chart claiming what was eaten in it.
   */
  noData?: boolean;
}

export interface EnergyBarsProps {
  days: EnergyBarsDay[];
  targetFraction?: number;
}

const GROW_DURATION = 700;
const GROW_STAGGER_MS = 50;

interface EnergyBarProps {
  index: number;
  day: EnergyBarsDay;
  instrument: InstrumentTokens;
}

// Kora ignition Task 8: bars grow from the baseline on mount, staggered
// i*50ms over ~700ms ease-out — instant under Reduce Motion. `scaleY` +
// `transformOrigin: "bottom"` grows the bar upward from its foot rather than
// from its vertical center, which is what "grow from baseline" means here.
function EnergyBar({ index, day, instrument }: EnergyBarProps) {
  const { reduceMotion } = useMotionPrefs();
  const scale = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      scale.value = 1;
      return;
    }
    scale.value = 0;
    scale.value = withDelay(
      index * GROW_STAGGER_MS,
      withTiming(1, { duration: GROW_DURATION, easing: Easing.out(Easing.cubic) }),
    );
  }, [day.fraction, reduceMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: scale.value }] }));

  // An empty track, not a bar of height zero: it occupies the slot so the
  // days stay aligned, while drawing nothing that could be read as an amount.
  if (day.noData) {
    return (
      <View
        testID={`ebar-${index}-nodata`}
        style={{
          flex: 1,
          height: 3,
          borderRadius: 6,
          backgroundColor: instrument.tick,
          opacity: 0.25,
        }}
      />
    );
  }

  return (
    <Animated.View
      testID={`ebar-${index}`}
      style={[
        {
          flex: 1,
          height: `${Math.min(Math.max(day.fraction, 0), 1) * 100}%`,
          borderRadius: 6,
          backgroundColor: day.over ? instrument.accent : instrument.tick,
          transformOrigin: "bottom",
        },
        animatedStyle,
      ]}
    />
  );
}

export function EnergyBars({ days, targetFraction = 0.74 }: EnergyBarsProps) {
  const { instrument } = useTheme();
  // Plain, sentence-case day labels ("today"/"—") — not mono, not engraved.
  // These are calendar labels, not instrument numerals or engravings (M4).
  const dayLabel = {
    fontSize: 10,
    color: instrument.mut,
  };

  return (
    <View>
      <View style={{ height: 86, position: "relative", flexDirection: "row", alignItems: "flex-end", gap: 6 }}>
        <View
          testID="ebar-target"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: `${(1 - targetFraction) * 100}%`,
            borderTopWidth: 1.5,
            borderStyle: "dashed",
            borderColor: instrument.tick,
          }}
        />
        {days.map((d, i) => (
          <EnergyBar key={i} index={i} day={d} instrument={instrument} />
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
        {days.map((d, i) => (
          <AppText key={i} maxFontSizeMultiplier={1.4} style={[dayLabel, { flex: 1, textAlign: "center" }]}>
            {d.label}
          </AppText>
        ))}
      </View>
    </View>
  );
}
