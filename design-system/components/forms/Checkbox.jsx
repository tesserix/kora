import React from "react";

/** Tesserix Checkbox — 18px box, rounded-sm, fills --primary + check when on. */
export function Checkbox({ checked, defaultChecked = false, onCheckedChange, disabled = false, style, ...props }) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const on = checked ?? internal;
  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!on);
    onCheckedChange?.(!on);
  };
  return (
    <button
      role="checkbox" aria-checked={on} disabled={disabled} onClick={toggle}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18,
        borderRadius: "var(--radius-sm)", border: on ? "1px solid var(--primary)" : "1.5px solid var(--input)",
        background: on ? "var(--primary)" : "var(--background)", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, padding: 0, flexShrink: 0, transition: "var(--transition-colors)", ...style,
      }}
      {...props}
    >
      {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--primary-foreground)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
    </button>
  );
}
