import { useEffect, useRef, useState } from "react";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

const DEBOUNCE_MS = 600;

interface PlanDeltaProps {
  kcal: number | null;
  floored: boolean;
  /**
   * Incremented by the parent on every input change. It is the only
   * evidence the user acted: when the resting-burn clamp binds, dragging
   * further leaves kcal untouched, so a change in kcal cannot be the
   * trigger. Without this the component would have to guess from render
   * count, and would announce on re-renders the user did not cause.
   */
  revision: number;
  testID?: string;
}

/**
 * Names the change the user just caused — the whole argument for this screen.
 * Silent on mount (nothing has changed yet) and debounced, so dragging a ruler
 * produces one announcement rather than a stream of interruptions.
 */
export function PlanDelta({ kcal, floored, revision, testID = "plan-delta" }: PlanDeltaProps) {
  const { instrument } = useTheme();
  const previous = useRef<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const prior = previous.current;
    previous.current = kcal;
    // First revision is mount: nothing has changed yet, so say nothing.
    if (prior === null || kcal === null) return;

    const delta = Math.round(kcal) - Math.round(prior);
    const next =
      delta !== 0
        ? `${delta > 0 ? "+" : "−"}${Math.abs(delta)} kcal from that change`
        : floored
          ? "held at your resting burn"
          : null;
    if (next === null) return;

    const timer = setTimeout(() => setMessage(next), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // revision is the deliberate trigger; kcal and floored are read as of that
    // revision. The directive must sit immediately above the dependency array —
    // with the prose between them it applied to a comment line and suppressed
    // nothing, which is how it read as "unused" while the warning still fired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

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
