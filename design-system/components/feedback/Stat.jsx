import React from "react";

/** Tesserix Stat — label + big value + optional delta/trend. For dashboards. */
export function Stat({ label, value, unit, delta, trend, style, ...props }) {
  const up = trend === "up";
  const color = trend ? (up ? "var(--success-muted-foreground)" : "var(--error-muted-foreground)") : "var(--muted-foreground)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-sans)", ...style }} {...props}>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: "var(--font-medium)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
        <span style={{ fontSize: "var(--text-3xl)", fontWeight: "var(--font-bold)", letterSpacing: "var(--tracking-tight)", color: "var(--foreground)" }}>{value}</span>
        {unit && <span style={{ fontSize: "var(--text-sm)", color: "var(--muted-foreground)", fontFamily: "var(--font-mono)" }}>{unit}</span>}
      </span>
      {delta != null && (
        <span style={{ fontSize: "var(--text-xs)", color, fontWeight: "var(--font-medium)", display: "inline-flex", alignItems: "center", gap: 3 }}>
          {trend && <span>{up ? "▲" : "▼"}</span>}{delta}
        </span>
      )}
    </div>
  );
}
