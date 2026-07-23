import { useColorScheme } from "react-native";
import { darkColors, fontSize, lightColors, radius, spacing } from "./tokens";

export type ThemeColors = Record<keyof typeof lightColors, string>;

export function useTheme() {
  const scheme = useColorScheme() ?? "light";
  const colors = scheme === "dark" ? darkColors : lightColors;
  return { colors, spacing, radius, fontSize, scheme } as const;
}
