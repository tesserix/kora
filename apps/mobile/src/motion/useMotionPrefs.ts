import { useReducedMotion } from "react-native-reanimated";

export function useMotionPrefs(): { reduceMotion: boolean } {
  return { reduceMotion: useReducedMotion() } as const;
}
