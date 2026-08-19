# Deferred items — 260819-pdp (kora#238)

Out of scope for this change (pre-existing, not caused by it). Logged, not fixed.

## 1. PlanDial does not render at all on device

`src/components/instrument/PlanDial.tsx` sizes its `<Svg>` with `width="100%"`.
In `app/onboarding.tsx` the dial's parent is `AuthScaffold`'s header `View`, which
sets `alignItems: "center"` — a center-aligned column gives its children no width
to be 100% *of*, so the SVG resolves to zero width and paints nothing. The
`height={GAUGE_VIEW_H}` is explicit, so the 178pt of vertical space is still
reserved: the dial reads as a blank gap above the kcal numeral rather than as a
missing component, which is presumably why it went unnoticed.

Confirmed on simulator (iPhone 17 Pro Max, prod API): identical blank gap on
`main` and on `perf/238-plandial`, and the dial paints correctly the moment
`width` is changed to the fixed `GAUGE_VIEW_W`. `GaugeDial` on Home uses
`width={GAUGE_VIEW_W}` and renders fine, which isolates the cause. `TickRuler`
also uses `width="100%"` but sits in a full-width column, so it is unaffected.

NOT fixed here because kora#238 is explicitly a pure performance change —
"Do NOT change what the dial looks like" — and making an invisible component
visible is the largest possible visual change. Needs its own issue.

## 2. Pre-existing lint error in GaugeDial

`react-hooks/set-state-in-effect` at `GaugeDial.tsx:301` (the ignition countdown
effect). Present on `main`, untouched by this change.
