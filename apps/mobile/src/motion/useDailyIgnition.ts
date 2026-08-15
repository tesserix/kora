import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "kora.ignition.lastPlayed";

// Fires the once-a-day ignition sequence: true exactly once per local-day
// key, persisted across app restarts via AsyncStorage. Reduce Motion (wired
// by the caller in Task 6) suppresses it entirely rather than substituting a
// reduced-motion variant — there is no calmer version of a one-shot flourish,
// only skipping it.
export function useDailyIgnition(todayKey: string, reducedMotion = false): boolean {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (reducedMotion) return;
    let live = true;
    AsyncStorage.getItem(KEY).then((last) => {
      if (!live || last === todayKey) return;
      AsyncStorage.setItem(KEY, todayKey);
      setPlay(true);
    });
    return () => {
      live = false;
    };
  }, [todayKey, reducedMotion]);
  return play;
}
