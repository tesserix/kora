import { useColorScheme } from "react-native";
import { darkColors, fontSize, lightColors, radius, spacing } from "./tokens";

export type ThemeColors = typeof lightColors;

export function useTheme() {
  const scheme = useColorScheme() ?? "light";
  const colors = scheme === "dark" ? darkColors : lightColors;
  return { colors, spacing, radius, fontSize, scheme } as const;
}
