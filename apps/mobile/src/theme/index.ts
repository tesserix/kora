import { Platform, useColorScheme } from "react-native";
import {
  darkColors, fontSize, gradientStops, lightColors, radius, spacing, type,
  instrumentDark, instrumentLight, type InstrumentTokens, INSTRUMENT_DARK_FIXED,
} from "./palette";

export { AppearanceProvider, useAppearance, type AppearancePreference } from "./AppearanceProvider";

export type ThemeColors = Record<keyof typeof lightColors, string>;
export type { InstrumentTokens };
export { INSTRUMENT_DARK_FIXED };

const fonts = {
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
  rounded: Platform.select({ ios: "ui-rounded", default: undefined }),
};

function makeShadows(scheme: "light" | "dark") {
  const shadowColor = "#000000";
  return {
    sm: { shadowColor, shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    md: { shadowColor, shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    lg: { shadowColor, shadowOpacity: 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 9 },
    card: { shadowColor, shadowOpacity: scheme === "dark" ? 0.55 : 0.12, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 9 },
  } as const;
}

export function useTheme() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const colors = scheme === "dark" ? darkColors : lightColors;
  const gradients = scheme === "dark" ? gradientStops.dark : gradientStops.light;
  const instrument = (scheme === "dark" ? instrumentDark : instrumentLight) as InstrumentTokens;
  return { colors, spacing, radius, fontSize, fonts, shadows: makeShadows(scheme), scheme, type, gradients, instrument } as const;
}
