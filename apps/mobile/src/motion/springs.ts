import type { WithSpringConfig } from "react-native-reanimated";

// Apple-derived: dampingRatio 1.0 = critically damped; response ≈ duration.
export const springs = {
  instant: { duration: 150, dampingRatio: 1 },
  standard: { duration: 350, dampingRatio: 1 },
  lively: { duration: 400, dampingRatio: 0.8 }, // gesture-released motion only
} as const satisfies Record<string, WithSpringConfig>;
