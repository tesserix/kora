import React from "react";

/** Tesserix Callout — inline message block. Variants map to status muted tokens (callout.tsx / alert.tsx). */
const VARIANTS = {
  info: { bg: "var(--info-muted)", fg: "var(--info-muted-foreground)", bd: "color-mix(in oklch, var(--info) 30%, transparent)" },
  success: { bg: "var(--success-muted)", fg: "var(--success-muted-foreground)", bd: "color-mix(in oklch, var(--success) 30%, transparent)" },
  warning: { bg: "var(--warning-muted)", fg: "var(--warning-muted-foreground)", bd: "color-mix(in oklch, var(--warning) 30%, transparent)" },
  error: { bg: "var(--error-muted)", fg: "var(--error-muted-foreground)", bd: "color-mix(in oklch, var(--error) 30%, transparent)" },
  neutral: { bg: "var(--neutral-muted)", fg: "var(--neutral-muted-foreground)", bd: "var(--border)" },
};
export function Callout({ variant = "info", title, icon, style, children, ...props }) {
  const v = VARIANTS[variant] || VARIANTS.info;
  return (
    <div role="note" style={{
      display: "flex", gap: 12, padding: 16, borderRadius: "var(--radius-lg)",
      background: v.bg, color: v.fg, border: `1px solid ${v.bd}`, fontFamily: "var(--font-sans)", ...style,
    }} {...props}>
      {icon && <span style={{ flexShrink: 0, marginTop: 1 }}>{icon}</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {title && <strong style={{ fontSize: "var(--text-sm)", fontWeight: "var(--font-semibold)" }}>{title}</strong>}
        <span style={{ fontSize: "var(--text-sm)", lineHeight: "var(--leading-normal)", opacity: 0.92 }}>{children}</span>
      </div>
    </div>
  );
}
