import React from "react";

/** Tesserix CircularProgress — ring gauge. Used for calorie/macro rings in the Kora app.
 *  Renders center content (children) e.g. a value + label. */
export function CircularProgress({ value = 0, max = 100, size = 96, stroke = 10, color = "var(--primary)", track = "var(--secondary)", children, style, ...props }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, ...style }} {...props}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} style={{ transition: "stroke-dashoffset var(--duration-slower) var(--ease-out)" }} />
      </svg>
      {children != null && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          {children}
        </div>
      )}
    </div>
  );
}
