import React from "react";

/** Tesserix Badge — pill, rounded-full, px-2.5 py-0.5, text-xs semibold.
 *  Variants map to the semantic status tokens (badge.tsx). */
const VARIANTS = {
  default: { background: "var(--primary)", color: "var(--primary-foreground)", border: "1px solid transparent", boxShadow: "var(--shadow-sm)" },
  secondary: { background: "var(--secondary)", color: "var(--secondary-foreground)", border: "1px solid transparent" },
  destructive: { background: "var(--destructive)", color: "var(--destructive-foreground)", border: "1px solid transparent" },
  outline: { background: "transparent", color: "var(--foreground)", border: "1px solid var(--border)" },
  success: { background: "var(--success-muted)", color: "var(--success-muted-foreground)", border: "1px solid transparent" },
  warning: { background: "var(--warning-muted)", color: "var(--warning-muted-foreground)", border: "1px solid transparent" },
  error: { background: "var(--error-muted)", color: "var(--error-muted-foreground)", border: "1px solid transparent" },
  info: { background: "var(--info-muted)", color: "var(--info-muted-foreground)", border: "1px solid transparent" },
  neutral: { background: "var(--neutral-muted)", color: "var(--neutral-muted-foreground)", border: "1px solid transparent" },
};

export function Badge({ variant = "default", style, children, ...props }) {
  const v = VARIANTS[variant] || VARIANTS.default;
  return (
    <span
      data-slot="badge"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
        width: "fit-content", flexShrink: 0, whiteSpace: "nowrap", borderRadius: "var(--radius-full)",
        padding: "2px 10px", fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)",
        fontWeight: "var(--font-semibold)", lineHeight: 1.35, ...v, ...style,
      }}
      {...props}
    >
      {children}
    </span>
  );
}
