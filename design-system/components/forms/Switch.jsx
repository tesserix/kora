import React from "react";

/** Tesserix Switch — track toggles to --primary when checked; 44x24 thumb. Controlled or uncontrolled. */
export function Switch({ checked, defaultChecked = false, onCheckedChange, disabled = false, style, ...props }) {
  const [internal, setInternal] = React.useState(defaultChecked);
  const on = checked ?? internal;
  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!on);
    onCheckedChange?.(!on);
  };
  return (
    <button
      role="switch" aria-checked={on} disabled={disabled} onClick={toggle}
      style={{
        position: "relative", width: 44, height: 24, borderRadius: "var(--radius-full)", border: "none",
        background: on ? "var(--primary)" : "var(--input)", cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1, transition: "background var(--duration-normal) var(--ease-in-out)",
        padding: 0, flexShrink: 0, ...style,
      }}
      {...props}
    >
      <span style={{
        position: "absolute", top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: "var(--radius-full)",
        background: "var(--background)", boxShadow: "var(--shadow-sm)", transition: "left var(--duration-normal) var(--ease-in-out)",
      }} />
    </button>
  );
}
