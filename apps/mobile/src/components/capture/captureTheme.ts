// Dark capture surface — the composer is a deliberate dark contrast to Kora's
// light editorial screens. Values translated from CaptureScreen.jsx's oklch
// (React Native cannot parse oklch) to hex/rgba.
export const captureColors = {
  surface: "#12211d", // oklch(0.19 0.03 165) — deep teal-black
  onSurface: "#ffffff",
  onSurfaceMuted: "rgba(255,255,255,0.6)",
  onSurfaceFaint: "rgba(255,255,255,0.55)",
  bubbleBg: "rgba(255,255,255,0.08)",
  bubbleBorder: "rgba(255,255,255,0.12)",
  cardBg: "rgba(255,255,255,0.07)",
  cardBorder: "rgba(255,255,255,0.14)",
  cardDivider: "rgba(255,255,255,0.1)",
  pillBg: "rgba(255,255,255,0.10)",
  pillFg: "rgba(255,255,255,0.75)",
  primary: "#9c92ff", // matches darkColors.primary in theme/tokens.ts
  primaryForeground: "#10101e", // matches darkColors.primaryForeground
  primaryGlow: "rgba(156,146,255,0.22)", // oklch color-mix(in oklch, var(--primary) 22%, transparent)
  composerBg: "rgba(0,0,0,0.25)",
  composerBorder: "rgba(255,255,255,0.1)",
  outlineBorder: "rgba(255,255,255,0.25)",
} as const;

export type CaptureColors = typeof captureColors;
