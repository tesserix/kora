import React from "react";

/** Tesserix Button — cva-derived variants translated to the token system.
 *  Exact geometry from button.tsx: h-10 default, rounded-lg, text-sm, gap-2. */
const VARIANTS = {
  default: { background: "var(--primary)", color: "var(--primary-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow)" },
  destructive: { background: "var(--destructive)", color: "var(--destructive-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow-sm)" },
  outline: { background: "var(--background)", color: "var(--foreground)", border: "1px solid var(--input)", boxShadow: "var(--shadow-sm)" },
  secondary: { background: "var(--secondary)", color: "var(--secondary-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow-sm)" },
  ghost: { background: "transparent", color: "var(--foreground)", border: "1px solid transparent" },
  link: { background: "transparent", color: "var(--primary)", border: "1px solid transparent", textDecoration: "underline", textUnderlineOffset: "4px" },
  success: { background: "var(--success)", color: "var(--success-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow-sm)" },
  warning: { background: "var(--warning)", color: "var(--warning-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow-sm)" },
};

const SIZES = {
  default: { height: 40, padding: "0 16px", fontSize: "var(--text-sm)", borderRadius: "var(--radius-lg)" },
  sm: { height: 36, padding: "0 12px", fontSize: "var(--text-xs)", borderRadius: "var(--radius-md)" },
  lg: { height: 48, padding: "0 32px", fontSize: "var(--text-base)", borderRadius: "var(--radius-lg)" },
  xl: { height: 56, padding: "0 40px", fontSize: "var(--text-lg)", borderRadius: "var(--radius-lg)" },
  icon: { height: 40, width: 40, padding: 0, borderRadius: "var(--radius-lg)" },
  "icon-sm": { height: 32, width: 32, padding: 0, borderRadius: "var(--radius-md)" },
  "icon-lg": { height: 44, width: 44, padding: 0, borderRadius: "var(--radius-lg)" },
};

export function Button({
  variant = "default",
  size = "default",
  isLoading = false,
  loadingText,
  disabled = false,
  style,
  children,
  ...props
}) {
  const v = VARIANTS[variant] || VARIANTS.default;
  const s = SIZES[size] || SIZES.default;
  const isDisabled = disabled || isLoading;
  return (
    <button
      disabled={isDisabled}
      aria-busy={isLoading || undefined}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        whiteSpace: "nowrap", fontFamily: "var(--font-sans)", fontWeight: "var(--font-medium)",
        lineHeight: 1, cursor: isDisabled ? "not-allowed" : "pointer",
        opacity: isDisabled ? 0.5 : 1, transition: "var(--transition-colors), box-shadow var(--duration-normal) var(--ease-in-out)",
        outline: "none", ...v, ...s, ...style,
      }}
      {...props}
    >
      {isLoading ? (
        <>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: "tsx-spin 0.8s linear infinite" }} aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
            <path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{loadingText || "Loading…"}</span>
        </>
      ) : children}
      <style>{"@keyframes tsx-spin{to{transform:rotate(360deg)}}"}</style>
    </button>
  );
}
