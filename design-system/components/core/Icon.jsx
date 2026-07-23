import React from "react";

/** Tesserix Icon — renders a Lucide glyph from the global `lucide` UMD build
 *  (window.lucide). Load once via:
 *    <script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>
 *  Builds inner SVG markup from the lucide IconNode array with strict guards so an
 *  unknown/misparsed icon degrades to an empty <svg> instead of throwing.
 *  Sizes match iconSizes (xs12 sm16 md20 lg24 xl32 2xl40); stroke 2 by default. */
const SIZES = { xs: 12, sm: 16, md: 20, lg: 24, xl: 32, "2xl": 40 };

function pascal(name) {
  return String(name).replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}

function getNode(name) {
  const g = typeof window !== "undefined" ? window.lucide : null;
  if (!g) return null;
  const p = pascal(name);
  const candidates = [g.icons && g.icons[p], g.icons && g.icons[name], g[p]];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

function nodeToInner(node) {
  if (!Array.isArray(node)) return "";
  // lucide IconNode shape: [tag, attrs, childrenArray]; real elements are at index [2].
  const children = Array.isArray(node[2]) ? node[2] : node;
  let out = "";
  for (const entry of children) {
    if (!Array.isArray(entry)) continue;
    const tag = entry[0];
    const attrs = entry[1] || {};
    if (typeof tag !== "string") continue;
    let a = "";
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || typeof v === "object") continue;
      a += ` ${k}="${String(v).replace(/"/g, "&quot;")}"`;
    }
    out += `<${tag}${a} />`;
  }
  return out;
}

export function Icon({ name, size = "md", color = "currentColor", strokeWidth = 2, style, ...props }) {
  const px = typeof size === "number" ? size : (SIZES[size] || 20);
  const inner = nodeToInner(getNode(name));
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" width={px} height={px} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: "inline-block", flexShrink: 0, verticalAlign: "middle", ...style }}
      aria-hidden="true" dangerouslySetInnerHTML={{ __html: inner }} {...props}
    />
  );
}
