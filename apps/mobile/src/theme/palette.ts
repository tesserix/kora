// Hand-authored iOS-native palette. Light/dark pairs. Do NOT regenerate from design-system.
const shared = {
  primaryForeground: "#FFFFFF",
  destructiveForeground: "#FFFFFF",
} as const;

export const lightColors = {
  ...shared,
  background: "#F2F2F7",
  foreground: "#000000",
  label: "#000000",
  secondaryLabel: "rgba(60,60,67,0.60)",
  tertiaryLabel: "rgba(60,60,67,0.30)",
  card: "#FFFFFF",
  cardForeground: "#000000",
  cardSecondary: "#F2F2F7",
  primary: "#34C759",
  secondary: "#F2F2F7",
  secondaryForeground: "#000000",
  muted: "#F2F2F7",
  mutedForeground: "rgba(60,60,67,0.60)",
  accent: "#34C759",
  accentForeground: "#FFFFFF",
  accentAmber: "#FF9500",
  accentBlue: "#007AFF",
  destructive: "#FF3B30",
  border: "rgba(60,60,67,0.29)",
  separator: "rgba(60,60,67,0.29)",
  input: "#F2F2F7",
  ring: "#34C759",
  success: "#34C759",
  warning: "#FF9500",
  error: "#FF3B30",
  info: "#007AFF",
} as const;

export const darkColors: Record<keyof typeof lightColors, string> = {
  ...shared,
  background: "#000000",
  foreground: "#FFFFFF",
  label: "#FFFFFF",
  secondaryLabel: "rgba(235,235,245,0.60)",
  tertiaryLabel: "rgba(235,235,245,0.30)",
  card: "#1C1C1E",
  cardForeground: "#FFFFFF",
  cardSecondary: "#2C2C2E",
  primary: "#30D158",
  primaryForeground: "#000000",
  secondary: "#2C2C2E",
  secondaryForeground: "#FFFFFF",
  muted: "#2C2C2E",
  mutedForeground: "rgba(235,235,245,0.60)",
  accent: "#30D158",
  accentForeground: "#000000",
  accentAmber: "#FF9F0A",
  accentBlue: "#0A84FF",
  destructive: "#FF453A",
  border: "rgba(84,84,88,0.60)",
  separator: "rgba(84,84,88,0.60)",
  input: "#2C2C2E",
  ring: "#30D158",
  success: "#30D158",
  warning: "#FF9F0A",
  error: "#FF453A",
  info: "#0A84FF",
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, "2xl": 48, "3xl": 64 } as const;
export const radius = { sm: 6, md: 10, lg: 12, xl: 16, "2xl": 24, "3xl": 32, full: 9999 } as const;
export const fontSize = { xs: 11, sm: 13, base: 15, lg: 17, xl: 22, "2xl": 28, "3xl": 34, "4xl": 40, "5xl": 52 } as const;

export type TypeVariant =
  | "largeTitle" | "title1" | "title2" | "headline" | "body" | "subheadline" | "footnote" | "caption";

export const type: Record<TypeVariant, { size: number; weight: "400" | "500" | "600" | "700"; letterSpacing: number; lineHeight?: number }> = {
  largeTitle: { size: 34, weight: "700", letterSpacing: -0.4, lineHeight: 41 },
  title1: { size: 28, weight: "700", letterSpacing: -0.4, lineHeight: 34 },
  title2: { size: 22, weight: "700", letterSpacing: -0.3, lineHeight: 28 },
  headline: { size: 17, weight: "600", letterSpacing: 0, lineHeight: 22 },
  body: { size: 17, weight: "400", letterSpacing: 0, lineHeight: 22 },
  subheadline: { size: 15, weight: "400", letterSpacing: 0, lineHeight: 20 },
  footnote: { size: 13, weight: "400", letterSpacing: 0, lineHeight: 18 },
  caption: { size: 11, weight: "500", letterSpacing: 0.5, lineHeight: 13 },
};
