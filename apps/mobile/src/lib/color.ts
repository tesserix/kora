// RN cannot derive alpha from a hex token at the stylesheet level (no color-mix()/oklch()),
// so tinted surfaces (e.g. Badge's 15%-opacity pill) compose an rgba() string from a
// theme token's hex value instead of hardcoding a literal color.
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;
  const value = parseInt(full, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
