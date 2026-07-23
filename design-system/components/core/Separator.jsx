import React from "react";

/** Tesserix Separator — hairline divider on --border. */
export function Separator({ orientation = "horizontal", style, ...props }) {
  const isV = orientation === "vertical";
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      style={{
        background: "var(--border)", flexShrink: 0,
        width: isV ? 1 : "100%", height: isV ? "100%" : 1, ...style,
      }}
      {...props}
    />
  );
}
