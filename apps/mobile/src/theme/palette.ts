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
  stepsMetric: "#8FD400",
  sleepMetric: "#7A6BFF",
  elevated: "#FFFFFF",
} as const;

export const darkColors: Record<keyof typeof lightColors, string> = {
  ...shared,
  background: "#0A0D0B",
  foreground: "#FFFFFF",
  label: "#F3F7F2",
  secondaryLabel: "rgba(233,242,232,0.62)",
  tertiaryLabel: "rgba(233,242,232,0.34)",
  card: "#151A16",
  cardForeground: "#FFFFFF",
  cardSecondary: "#1C231D",
  primary: "#3DDC6E",
  primaryForeground: "#06120A",
  secondary: "#1C231D",
  secondaryForeground: "#FFFFFF",
  muted: "rgba(255,255,255,0.07)",
  mutedForeground: "rgba(233,242,232,0.62)",
  accent: "#3DDC6E",
  accentForeground: "#06120A",
  accentAmber: "#FFB23E",
  accentBlue: "#4FA8FF",
  destructive: "#FF453A",
  border: "rgba(255,255,255,0.09)",
  separator: "rgba(255,255,255,0.08)",
  input: "#1C231D",
  ring: "#3DDC6E",
  success: "#3DDC6E",
  warning: "#FF9F0A",
  error: "#FF453A",
  info: "#0A84FF",
  stepsMetric: "#B6FF3D",
  sleepMetric: "#8B7CFF",
  elevated: "#1C231D",
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

export type GradientSet = {
  green: [string, string];
  amber: [string, string];
  blue: [string, string];
  steps: [string, string];
  sleep: [string, string];
};

// 2-stop [bright, deep] gradient pairs per scheme, tuned so the arc reads as a
// filled sweep. Green stays the hero; amber/blue power the carbs/fat macro
// fills; steps=lime, sleep=violet mirror the metric hues above.
export const gradientStops: { light: GradientSet; dark: GradientSet } = {
  light: {
    green: ["#34C759", "#1E9E4A"],
    amber: ["#FFB340", "#F08C00"],
    blue: ["#4DA2FF", "#0A63D6"],
    steps: ["#A6E635", "#6FA800"],
    sleep: ["#8E82FF", "#5E4FE0"],
  },
  dark: {
    green: ["#3DDC6E", "#12A150"],
    amber: ["#FFC15E", "#FF9F0A"],
    blue: ["#6FB6FF", "#0A84FF"],
    steps: ["#C4FF5E", "#8FD400"],
    sleep: ["#9E90FF", "#6E5FE8"],
  },
};
