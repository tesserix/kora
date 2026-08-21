import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SplashScreen from "expo-splash-screen";

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
  // Lazy initializer, not a bare render-body call: it runs exactly once,
  // synchronously, before the AsyncStorage read below ever starts — so
  // useColorScheme() consumers (useTheme(), navigation) see dark from the
  // very first render instead of leaking the device's scheme until
  // hydration resolves.
  const [preference, setPreferenceState] = useState<AppearancePreference>(() => {
    applyPreference("dark");
    return "dark";
  });

  useEffect(() => {
    let cancelled = false;
    // The app is behind the native splash until this resolves (kora#320): the
    // scheme swap below would otherwise happen in front of the user, which is
    // what the dark flash was. Hiding is idempotent and must happen on EVERY
    // path out of here — including the failure path and the timeout below.
    // Being stuck on the splash forever is far worse than a flash, so this is
    // the one thing in this file that must not depend on storage behaving.
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      void SplashScreen.hideAsync().catch(() => {});
    };
    // AsyncStorage rejecting is handled below; AsyncStorage never SETTLING is
    // not, and has no upper bound. This is the backstop for that case only —
    // it should never fire in practice, and if it does the app opens in dark
    // and corrects itself when the read lands.
    const timer = setTimeout(reveal, 2000);

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
      })
      .finally(() => {
        clearTimeout(timer);
        reveal();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Unmounting before the read lands must not strand the splash.
      reveal();
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
