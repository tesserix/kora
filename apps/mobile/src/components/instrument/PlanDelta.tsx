import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { useTheme } from "@/theme";

const DEBOUNCE_MS = 600;

const HELD_MESSAGE = "held at your resting burn";

function deltaMessage(delta: number): string {
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)} kcal from that change`;
}

/**
 * The placeholder that holds the line open before anything has been said, and
 * the reason nothing below this component moves. It is the longest string the
 * component can produce: the delta form is two characters longer than
 * `HELD_MESSAGE`, and 8888 is both the widest four-digit magnitude and larger
 * than any plausible delta between two daily targets. `PlanDelta.test.tsx`
 * pins that no message the component can build is longer than this.
 *
 * It is a real render of the real text in the real style, so the reserved box
 * is whatever the platform actually lays this variant out as — at the current
 * Dynamic Type size, with the current wrap. A points constant could not be:
 * at accessibility sizes the caption wraps, and one authored number cannot be
 * right at both one line and three.
 */
export const RESERVE_TEXT = deltaMessage(-8888);

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
 *
 * Silent does not mean absent. Returning `null` until the first message cost a
 * swipe during kora#270's verification: the line appeared mid-drag, pushed the
 * rulers down by its own height and slid the ruler out from under a finger
 * that was already on it, under a sticky header. So the line is always
 * reserved (see `RESERVE_TEXT`) and the message is drawn on top of it
 * absolutely — out of flow, so neither its arrival nor a change from one
 * message to another can move anything (kora#284).
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
    const next = delta !== 0 ? deltaMessage(delta) : floored ? HELD_MESSAGE : null;
    if (next === null) return;

    const timer = setTimeout(() => setMessage(next), DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // revision is the deliberate trigger; kcal and floored are read as of that
    // revision. The directive must sit immediately above the dependency array —
    // with the prose between them it applied to a comment line and suppressed
    // nothing, which is how it read as "unused" while the warning still fired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const face = {
    color: instrument.accent,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  } as const;

  return (
    <View testID={testID} style={{ alignItems: "center" }}>
      {/*
        Invisible, and hidden from assistive tech on both platforms: an empty
        line must not be announced and must not take a stop in the VoiceOver
        order. Only the message below carries the live region.
      */}
      <AppText
        testID={`${testID}-reserve`}
        variant="caption"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[face, { opacity: 0 }]}
      >
        {RESERVE_TEXT}
      </AppText>
      {message ? (
        // Absolute, so the box measured above is the only thing in flow. The
        // wrapper is as wide as the placeholder, so left/right/textAlign
        // reproduce the centring the parent used to give this text directly.
        <AppText
          testID={`${testID}-text`}
          variant="caption"
          accessibilityLiveRegion="polite"
          style={[face, { position: "absolute", top: 0, left: 0, right: 0, textAlign: "center" }]}
        >
          {message}
        </AppText>
      ) : null}
    </View>
  );
}
