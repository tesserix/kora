// RN cannot render oklch(); these approximate the mockup's single-hue tints in hsl().
export const tileBg = (hue: number): string => `hsl(${hue}, 45%, 90%)`;
export const tileFg = (hue: number): string => `hsl(${hue}, 55%, 42%)`;
export const tileFaint = (hue: number): string => `hsl(${hue}, 30%, 95%)`;
export const dot = (hue: number): string => `hsl(${hue}, 60%, 50%)`;

export const MACRO = {
  protein: { hue: 285 },
  carbs: { hue: 45 },
  fat: { hue: 30 },
} as const;
