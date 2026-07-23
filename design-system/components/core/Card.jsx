import React from "react";

/** Tesserix Card — rounded-xl, border, bg-card. `glass` variant uses backdrop-blur.
 *  Exact from card.tsx (shadow-lg → hover shadow-xl). */
export function Card({ variant = "default", style, children, ...props }) {
  const base = {
    borderRadius: "var(--radius-xl)", color: "var(--card-foreground)",
    transition: "var(--transition-all)", fontFamily: "var(--font-sans)",
  };
  const v = variant === "glass"
    ? { border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.1)", boxShadow: "var(--shadow-xl)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }
    : { border: "1px solid var(--border)", background: "var(--card)", boxShadow: "var(--shadow-lg)" };
  return <div data-slot="card" style={{ ...base, ...v, ...style }} {...props}>{children}</div>;
}

export function CardHeader({ style, children, ...props }) {
  return <div data-slot="card-header" style={{ display: "grid", gap: 8, padding: 24, ...style }} {...props}>{children}</div>;
}
export function CardTitle({ style, children, ...props }) {
  return <h3 data-slot="card-title" style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: "var(--font-bold)", lineHeight: "var(--leading-tight)", letterSpacing: "var(--tracking-tight)", ...style }} {...props}>{children}</h3>;
}
export function CardDescription({ style, children, ...props }) {
  return <div data-slot="card-description" style={{ fontSize: "var(--text-sm)", color: "var(--muted-foreground)", ...style }} {...props}>{children}</div>;
}
export function CardContent({ style, children, ...props }) {
  return <div data-slot="card-content" style={{ padding: "0 24px 24px", ...style }} {...props}>{children}</div>;
}
export function CardFooter({ style, children, ...props }) {
  return <div data-slot="card-footer" style={{ display: "flex", alignItems: "center", padding: "0 24px 24px", ...style }} {...props}>{children}</div>;
}
