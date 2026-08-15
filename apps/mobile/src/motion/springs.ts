import type { WithSpringConfig } from "react-native-reanimated";

// Total length of the reduced-motion substitute for a sweep (spec: Motion >
// prefers-reduced-motion, "needle sweeps become cross-fades"). Split in half
// between fading the old value out and the new one in. Deliberately shorter
// than the motion it replaces — a cross-fade that lingers reads as a lag.
export const REDUCED_MOTION_CROSSFADE_MS = 180;

// Apple-derived: dampingRatio 1.0 = critically damped; response ≈ duration.
export const springs = {
  instant: { duration: 150, dampingRatio: 1 },
  standard: { duration: 350, dampingRatio: 1 },
  lively: { duration: 400, dampingRatio: 0.8 }, // gesture-released motion only
} as const satisfies Record<string, WithSpringConfig>;
