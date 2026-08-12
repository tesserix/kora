import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "kora.appearance";

export type AppearancePreference = "system" | "light" | "dark";

type AppearanceContextValue = {
  preference: AppearancePreference;
  setPreference: (preference: AppearancePreference) => void;
};

const AppearanceContext = createContext<AppearanceContextValue | undefined>(undefined);

function isAppearancePreference(value: unknown): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

// applyPreference pushes the choice down to React Native's Appearance module.
// "unspecified" hands control back to the device setting; a literal scheme
// overrides it. (RN 0.86 replaced the older `null` sentinel: setColorScheme
// takes 'light' | 'dark' | 'unspecified', and only 'unspecified' re-reads the
// system scheme — see Libraries/Utilities/Appearance.js.) Every existing
// useColorScheme() consumer — useTheme(), navigation — reads through this same
// module, so nothing else has to be rewired.
function applyPreference(preference: AppearancePreference): void {
  Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  // Dark is Kora's home, not the device's. Instrument Glass is a dark-first
  // instrument panel and capture is dark-only regardless, so absent any
  // stored choice we open in dark. A stored "system" still means what it
  // says — someone who explicitly picked System in Settings gets the
  // device's scheme via applyPreference's "unspecified" sentinel below.
  const [preference, setPreferenceState] = useState<AppearancePreference>("dark");

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        const next = isAppearancePreference(stored) ? stored : "dark";
        setPreferenceState(next);
        applyPreference(next);
      })
      .catch(() => {
        // Best-effort read; fall back to Kora's dark default rather than
        // guessing at a stored preference we couldn't retrieve.
        if (!cancelled) applyPreference("dark");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setPreference(next: AppearancePreference) {
    setPreferenceState(next);
    applyPreference(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Best-effort write; never throw from a preference toggle.
    });
  }

  return (
    <AppearanceContext.Provider value={{ preference, setPreference }}>
      {children}
    </AppearanceContext.Provider>
  );
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (context === undefined) {
    // Match the provider's dark default so a component rendered outside
    // the provider (e.g. in isolation in a test) doesn't disagree with it.
    return { preference: "dark", setPreference: () => {} };
  }
  return context;
}
