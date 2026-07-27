import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { UnitSystem } from "./convert";

const STORAGE_KEY = "kora.units";

type UnitsContextValue = {
  system: UnitSystem;
  setSystem: (system: UnitSystem) => void;
};

const UnitsContext = createContext<UnitsContextValue | undefined>(undefined);

function isUnitSystem(value: unknown): value is UnitSystem {
  return value === "metric" || value === "imperial";
}

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [system, setSystemState] = useState<UnitSystem>("metric");

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!cancelled && isUnitSystem(stored)) {
          setSystemState(stored);
        }
      })
      .catch(() => {
        // Best-effort read; fall back to the default metric system.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setSystem(next: UnitSystem) {
    setSystemState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Best-effort write; never throw from a preference toggle.
    });
  }

  return <UnitsContext.Provider value={{ system, setSystem }}>{children}</UnitsContext.Provider>;
}

export function useUnits(): UnitsContextValue {
  const context = useContext(UnitsContext);
  if (context === undefined) {
    return { system: "metric", setSystem: () => {} };
  }
  return context;
}
