// Dark capture surface — the composer is a deliberate always-dark surface,
// intentionally decoupled from the app's light/dark theme toggle (it never
// follows the user's theme preference). Re-based on Kora's dark-mode system
// palette (see src/theme/palette.ts darkColors) rather than the screen's old
// bespoke indigo accent: true-black background, #1C1C1E/#2C2C2E elevated
// surfaces, #30D158 green accent, and dark-scheme label opacities for text.
export const captureColors = {
  surface: "#000000", // darkColors.background
  onSurface: "#ffffff", // darkColors.label
  onSurfaceMuted: "rgba(235,235,245,0.60)", // darkColors.secondaryLabel
  onSurfaceFaint: "rgba(235,235,245,0.30)", // darkColors.tertiaryLabel
  bubbleBg: "rgba(255,255,255,0.08)",
  bubbleBorder: "rgba(255,255,255,0.12)",
  cardBg: "#1C1C1E", // darkColors.card
  cardBorder: "rgba(84,84,88,0.60)", // darkColors.border/separator
  cardDivider: "rgba(84,84,88,0.36)",
  pillBg: "#2C2C2E", // darkColors.cardSecondary — round buttons, composer bar, inactive pills
  pillFg: "rgba(235,235,245,0.60)", // darkColors.secondaryLabel
  primary: "#30D158", // darkColors.primary — replaces the old #9c92ff indigo accent
  primaryForeground: "#000000", // darkColors.primaryForeground — pairs with the green accent
  primaryGlow: "rgba(48,209,88,0.22)", // color-mix(in oklch, primary 22%, transparent), green
  composerBg: "#1C1C1E",
  composerBorder: "rgba(84,84,88,0.60)",
  outlineBorder: "rgba(255,255,255,0.25)",
  sendInactiveBg: "rgba(255,255,255,0.15)", // disabled Send button fill
  // DetectedCard item tiles — a fixed dark squircle + green-tinted symbol
  // (tileBgDark/tileFgDark's per-food hue tint retires with FoodTile, task 13).
  tileBg: "#2C2C2E",
  tileFg: "#8FE3A6",
  // Photo idle affordance is a deliberately light "viewfinder" placeholder box.
  // Retinted from the old indigo hue family to a green tint so no indigo
  // remains anywhere in the capture surface.
  viewfinderBg: "#DCF4E3",
  viewfinderIcon: "#1F8A43",
  viewfinderCaption: "#1B6636",
} as const;

export type CaptureColors = typeof captureColors;
