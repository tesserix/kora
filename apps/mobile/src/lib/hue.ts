// RN cannot render oklch(); these approximate the mockup's single-hue tints in hsl().
export const tileBg = (hue: number): string => `hsl(${hue}, 45%, 90%)`;
export const tileFg = (hue: number): string => `hsl(${hue}, 55%, 42%)`;
export const tileFaint = (hue: number): string => `hsl(${hue}, 30%, 95%)`;
export const dot = (hue: number): string => `hsl(${hue}, 60%, 50%)`;

// Dark-surface variants for the capture DetectedCard, which sits on the dark
// composer rather than Kora's light editorial screens. CaptureScreen.jsx uses
// oklch(0.4 0.1 hue) tile bg with an oklch(0.9 0.08 hue) icon — approximated in hsl.
export const tileBgDark = (hue: number): string => `hsl(${hue}, 40%, 32%)`;
export const tileFgDark = (hue: number): string => `hsl(${hue}, 50%, 84%)`;

export const MACRO = {
  protein: { hue: 285 },
  carbs: { hue: 45 },
  fat: { hue: 30 },
} as const;
