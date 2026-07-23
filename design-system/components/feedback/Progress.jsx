import React from "react";

/** Tesserix Progress — linear bar. Track --secondary, fill --primary (or `color` override). */
export function Progress({ value = 0, max = 100, color = "var(--primary)", height = 8, style, ...props }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}
      style={{ width: "100%", height, borderRadius: "var(--radius-full)", background: "var(--secondary)", overflow: "hidden", ...style }} {...props}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: "var(--radius-full)", transition: "width var(--duration-slow) var(--ease-out)" }} />
    </div>
  );
}
