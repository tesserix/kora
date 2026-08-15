# Material & Panels — the Ignition surface system

## Design Decisions
- **One bezel-grade instrument per screen.** The screen's hero (Home energy cluster,
  Diary day-total, Trends weight, More identity hero) gets the full BezelCluster
  treatment; everything else sits on lighter sheened glass or directly on the ground.
  This hierarchy rule is what makes the design feel classy instead of loud.
- **Bezel rim = two-stop linear gradient**, top-light → bottom-shade. The conic
  "brushed metal" sweep from the mockups was DROPPED after the RN feasibility review
  (no conic gradients without adding Skia, which was rejected as a dependency).
- **Fused clusters wrap only fixed-cardinality content.** Never put an unbounded list
  (meal log) inside a cluster — it can't virtualize and blocks swipe-to-edit. Meal rows
  always live in a card-free hairline list (time column 60px mono / name / kcal mono).
- **Recessed wells** (vitals footer, water well, icon wells, active tab, selected day):
  `inset` token fill + hairline top edge. RN has no inset box-shadow — reuse the
  FloatingTabBar recipe (inset fill + glassBorder ring), never try to port the CSS.
- **Zone rules** divide sections inside a cluster: engraved 10px uppercase label
  flanked by hairlines. They replace inter-card gaps.
- **Light mode has its own finish values** — not just swapped colors: shade drops
  from rgba(0,0,0,.28) to rgba(22,24,28,.12), well shadows .25→.08, and the lume
  text glow turns OFF entirely (a halo behind near-black numerals reads as smudge).

## CSS Patterns (from winning variants)
```css
/* Bezel rim (padding trick; RN: wrap GlassPanel in a gradient View with 1.5 inset) */
.bezel { border-radius: 28px; padding: 1.5px; box-shadow: var(--shadow-card);
  background: linear-gradient(180deg, var(--glass-highlight), transparent 22%, var(--shade) 90%); }
.cluster { border-radius: 26.5px; border: 1px solid var(--glass-border);
  background: radial-gradient(150% 80% at 50% -18%, var(--glass-highlight), transparent 40%), var(--glass);
  backdrop-filter: blur(20px); }

/* Zone rule */
.zone-rule { display: flex; align-items: center; gap: 10px; }
.zone-rule::before, .zone-rule::after { content: ""; flex: 1; height: 1px; background: var(--hairline); }

/* Recessed well footer */
.well-footer { background: var(--inset); border-top: 1px solid var(--hairline); padding: 12px 16px; }
```
New tokens introduced (added to sketch theme; port into palette.ts instrument sets):
`shade`, `well-shadow`, `lume-text`, `lume-accent` — each with distinct dark/light values
(see sources/themes/default.css).

## Radius convention
Bezel hero 24–28 · standard glass 22 · strips/tiles 18–20 · wells 10–16 · dock 31/29.5.

## What to Avoid
- Six identical stacked glass cards at equal weight — the exact monotony this redesign fixes.
- Editorial no-cards-at-all (sketch 001 variant B) — rejected by user; hierarchy didn't hold.
- Glass on glass; more than one bezel per screen; conic gradients; true inset shadows.

## Origin
Sketches 001 (variant D winner), 002. Specialist review: sources/REVIEW-ignition.md.
