import React from "react";

/** Tesserix Tag — rounded chip, optional removable & leading dot. Lighter than Badge, for filters/inputs. */
export function Tag({ children, onRemove, color, style, ...props }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, borderRadius: "var(--radius-md)",
        padding: "4px 10px", background: "var(--secondary)", color: "var(--secondary-foreground)",
        border: "1px solid var(--border)", fontFamily: "var(--font-sans)", fontSize: "var(--text-xs)",
        fontWeight: "var(--font-medium)", ...style,
      }}
      {...props}
    >
      {color && <span style={{ width: 8, height: 8, borderRadius: "var(--radius-full)", background: color }} />}
      {children}
      {onRemove && (
        <button onClick={onRemove} aria-label="Remove" style={{ display: "inline-flex", border: "none", background: "none", padding: 0, marginLeft: 2, cursor: "pointer", color: "inherit", opacity: 0.6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
    </span>
  );
}
