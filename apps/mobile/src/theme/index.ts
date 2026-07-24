import { Platform, useColorScheme } from "react-native";
import { darkColors, fontSize, lightColors, radius, spacing } from "./tokens";

export type ThemeColors = Record<keyof typeof lightColors, string>;

const fonts = {
  mono: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string,
};

function makeShadows(scheme: "light" | "dark") {
  const shadowColor = scheme === "dark" ? "#000000" : "#0f1729";
  return {
    sm: { shadowColor, shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    md: { shadowColor, shadowOpacity: 0.1, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
    lg: { shadowColor, shadowOpacity: 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 9 },
  } as const;
}

export function useTheme() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const colors = scheme === "dark" ? darkColors : lightColors;
  return { colors, spacing, radius, fontSize, fonts, shadows: makeShadows(scheme), scheme } as const;
}
