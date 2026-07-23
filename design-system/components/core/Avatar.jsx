import React from "react";

/** Tesserix Avatar — circular image with initials fallback. sm32 md40 lg48 xl64. */
const SIZES = { sm: 32, md: 40, lg: 48, xl: 64 };
export function Avatar({ src, alt = "", initials, size = "md", style, ...props }) {
  const px = typeof size === "number" ? size : (SIZES[size] || 40);
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: px, height: px, borderRadius: "var(--radius-full)", overflow: "hidden",
        background: "var(--muted)", color: "var(--muted-foreground)", flexShrink: 0,
        fontFamily: "var(--font-sans)", fontWeight: "var(--font-semibold)", fontSize: px * 0.4,
        border: "1px solid var(--border)", ...style,
      }}
      {...props}
    >
      {src ? <img src={src} alt={alt} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : (initials || "").slice(0, 2).toUpperCase()}
    </span>
  );
}
