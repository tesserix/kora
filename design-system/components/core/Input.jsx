import React from "react";

/** Tesserix Input — h-11, rounded-lg, border-2, px-4, focus ring 4px/20%.
 *  Exact from input.tsx (validity states + helper/error text). */
export function Input({ isValid, isInvalid, helperText, errorText, style, id, ...props }) {
  const [focused, setFocused] = React.useState(false);
  const autoId = React.useId();
  const inputId = id || autoId;
  const showError = isInvalid && errorText;
  const showHelper = helperText && !showError;
  let borderColor = "var(--input)";
  let ring = "transparent";
  if (isValid) { borderColor = "oklch(0.63 0.16 150)"; }
  if (isInvalid) { borderColor = "var(--destructive)"; }
  if (focused) {
    borderColor = isInvalid ? "var(--destructive)" : isValid ? "oklch(0.63 0.16 150)" : "var(--ring)";
    ring = isInvalid ? "oklch(0.58 0.2157 27.72 / 0.2)" : isValid ? "oklch(0.63 0.16 150 / 0.2)" : "color-mix(in oklch, var(--ring) 20%, transparent)";
  }
  const input = (
    <input
      id={inputId}
      aria-invalid={isInvalid || undefined}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={{
        height: 44, width: "100%", boxSizing: "border-box", borderRadius: "var(--radius-lg)",
        border: `2px solid ${borderColor}`, background: "var(--background)", color: "var(--foreground)",
        padding: (isValid || isInvalid) ? "10px 40px 10px 16px" : "10px 16px",
        fontSize: "var(--text-sm)", fontFamily: "var(--font-sans)", boxShadow: `var(--shadow-sm), 0 0 0 4px ${ring}`,
        outline: "none", transition: "var(--transition-all)",
      }}
      {...props}
    />
  );
  if (!isValid && !isInvalid && !helperText && !errorText) return input;
  return (
    <div style={{ width: "100%" }}>
      <div style={{ position: "relative" }}>
        {input}
        {isValid && !isInvalid && (
          <svg style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="oklch(0.55 0.15 150)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        )}
        {isInvalid && (
          <svg style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--destructive)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>
        )}
      </div>
      {showError && <p role="alert" style={{ margin: "6px 0 0", fontSize: "var(--text-xs)", color: "var(--destructive)" }}>{errorText}</p>}
      {showHelper && <p style={{ margin: "6px 0 0", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>{helperText}</p>}
    </div>
  );
}
