import React from "react";

/** Tesserix Skeleton — shimmer placeholder on --muted. */
export function Skeleton({ width = "100%", height = 16, radius = "var(--radius-md)", style, ...props }) {
  return (
    <div style={{ width, height, borderRadius: radius, background: "var(--muted)", position: "relative", overflow: "hidden", ...style }} {...props}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, transparent, color-mix(in oklch, var(--background) 55%, transparent), transparent)", animation: "tsx-shimmer 1.4s infinite" }} />
      <style>{"@keyframes tsx-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}"}</style>
    </div>
  );
}
