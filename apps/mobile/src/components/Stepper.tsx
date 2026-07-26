import { useCallback, useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "@/components/Icon";
import { AppText } from "@/components/Text";
import { haptics } from "@/motion";
import { useTheme } from "@/theme";

interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
}

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 120;

// iOS capsule stepper: a single `cardSecondary` pill holding − / value / + with
// hairline dividers. Holding either button repeats the tick (400ms delay, then
// every 120ms) until release; a quick tap ticks once. Timers live in refs and
// are cleared on pressOut and on unmount.
export function Stepper({ value, onChange, step = 10, min = 0 }: StepperProps) {
  const { colors, radius } = useTheme();

  const valueRef = useRef(value);
  valueRef.current = value;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const repeatedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const tick = useCallback(
    (delta: number) => {
      const next = Math.max(min, valueRef.current + delta);
      valueRef.current = next;
      haptics.selection();
      onChange(next);
    },
    [min, onChange],
  );

  const handlePressIn = useCallback(
    (delta: number) => {
      repeatedRef.current = false;
      timeoutRef.current = setTimeout(() => {
        repeatedRef.current = true;
        tick(delta);
        intervalRef.current = setInterval(() => tick(delta), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    [tick],
  );

  const handlePress = useCallback(
    (delta: number) => {
      // A press-and-hold already ticked via the repeat interval — the trailing
      // onPress that fires on release should not add one more tick on top.
      if (!repeatedRef.current) tick(delta);
    },
    [tick],
  );

  const btn = {
    width: 36,
    height: 36,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  const divider = { width: 1, height: 20, backgroundColor: colors.separator };

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.cardSecondary,
        borderRadius: radius.full,
        overflow: "hidden",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease"
        onPressIn={() => handlePressIn(-step)}
        onPressOut={clearTimers}
        onPress={() => handlePress(-step)}
        style={btn}
      >
        <Icon name="minus" size={14} color={colors.label} />
      </Pressable>
      <View style={divider} />
      <AppText variant="subheadline" style={{ minWidth: 56, textAlign: "center", fontVariant: ["tabular-nums"] }}>
        {value} g
      </AppText>
      <View style={divider} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase"
        onPressIn={() => handlePressIn(step)}
        onPressOut={clearTimers}
        onPress={() => handlePress(step)}
        style={btn}
      >
        <Icon name="plus" size={14} color={colors.label} />
      </Pressable>
    </View>
  );
}
