import { useEffect, useRef, useState } from "react";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

const DEBOUNCE_MS = 600;

interface PlanDeltaProps {
  kcal: number | null;
  floored: boolean;
  testID?: string;
}

/**
 * Names the change the user just caused — the whole argument for this screen.
 * Silent on mount (nothing has changed yet) and debounced, so dragging a ruler
 * produces one announcement rather than a stream of interruptions.
 */
export function PlanDelta({ kcal, floored, testID = "plan-delta" }: PlanDeltaProps) {
  const { instrument } = useTheme();
  const previous = useRef<number | null>(null);
  // A [floored, kcal] dependency array would make React bail out of the
  // effect whenever two consecutive renders carry the same primitive values —
  // exactly the case where the clamp binds twice in a row (the ruler moves,
  // the target stays put). The effect must run on every commit so that case
  // is still observed; skipNext guards against the render our own setMessage
  // call triggers reprocessing itself into a runaway timer loop.
  const skipNext = useRef(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      previous.current = kcal;
      return;
    }

    const prior = previous.current;
    previous.current = kcal;
    if (prior === null || kcal === null) return;

    const delta = Math.round(kcal) - Math.round(prior);
    const next =
      delta !== 0
        ? `${delta > 0 ? "+" : "−"}${Math.abs(delta)} kcal from that change`
        : floored
          ? "held at your resting burn"
          : null;
    if (next === null) return;

    const timer = setTimeout(() => {
      skipNext.current = true;
      setMessage(next);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  if (!message) return null;

  return (
    <AppText
      testID={`${testID}-text`}
      variant="caption"
      accessibilityLiveRegion="polite"
      style={{ color: instrument.accent, letterSpacing: 1.2, textTransform: "uppercase" }}
    >
      {message}
    </AppText>
  );
}
