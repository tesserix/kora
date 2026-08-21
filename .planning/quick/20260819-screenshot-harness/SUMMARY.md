---
quick_id: 260819-ssh
slug: screenshot-harness
date: 2026-08-19
refs: kora#257
branch: test/257-screenshot-harness
---

# Summary — screenshot capture harness + noise report

Built the **capture half** of kora#257. No assertions, no goldens, nothing
wired into CI — deliberately, per the plan. The deliverable that matters is
[`NOISE-REPORT.md`](./NOISE-REPORT.md).

## What shipped

| file | what it is |
| ---- | ---------- |
| `apps/mobile/scripts/shots.mjs` | unattended capture: resolves the simulator, sets content size, relaunches, walks the route list by deep link, writes PNGs + `manifest.json` |
| `apps/mobile/scripts/shots.routes.mjs` | the route list — the one file to edit to add a screen |
| `apps/mobile/scripts/shots-noise.mjs` | noise-floor analyser over a `--repeat N` capture directory |
| `.gitignore` | `.shots/` ignored |

    node scripts/shots.mjs --content-size medium --out .shots/medium
    node scripts/shots.mjs --content-size accessibility-extra-large --out .shots/axl
    node scripts/shots-noise.mjs .shots/medium

Notable behaviours, all required by the plan:

- **Refuses to run on anything but iPhone 17 Pro Max** unless `--allow-any-device`,
  with an error that says why.
- Sets content size **then relaunches** — a running app does not reflow. Verified:
  the same `settings` route reflows from a compact list to two lines per row.
- Does **not** script sign-up. Usage text says to sign in by hand once. Routes
  that bounce to the sign-in wall are captured anyway and flagged
  `landedOnSignIn` in the manifest (16x16 grayscale fingerprint, ImageMagick
  optional).
- `--repeat N` and `--relaunch-each-repeat` exist so the noise floor can be
  re-measured, not just measured once.

## Evidence collected

168 captures: 14 routes x 3 passes x {medium, accessibility-extra-large} x
{within-one-launch, across-launches}, on iPhone 17 Pro Max / iOS 26.2 against
prod.

## Headline findings

1. **The renderer is not the noise source.** Within one launch, no pixel in any
   of 84 comparisons exceeded 4/255; worst case was 879 pixels at delta 2/255
   (0.023% of frame). Most routes were bit-identical. This contradicts the
   ~3,933-pixels figure in the plan, which was measuring app state.
2. **Across launches the noise is app state.** Same route, different screen:
   `Loading…` / `Couldn't load your profile — Retry` / loaded data. That is
   maxΔ 255 over up to 47.8% of the frame. No tolerance absorbs it.
3. **A second, smaller across-launch effect is real and measurable:** a
   ~0.25 device-pixel vertical drift of the composited card on the tab screens,
   costing 0.75–0.80% of the frame above 8/255, edge-only, spatially scattered
   (densest 60x60 block reaches only ~18% density).
4. **Diffing would not have caught what looking caught.** The run surfaced four
   live layout bugs no golden diff could ever report, because a golden would
   enshrine them — including the onboarding goal ruler reading **"Build m"** at
   the *default* content size, which is precisely the #257 motivating bug class.

## Recommendation (detail in NOISE-REPORT.md §5)

Not "pixel diffing is too flaky" and not "commit goldens now". The blocker is
determinism of app state, not tolerance tuning:

- **Stage B (prerequisite):** capture client with `expo-linear-gradient` and the
  dev menu disabled; seeded/fixture backend instead of prod; a readiness gate
  replacing the fixed settle timer so a `Loading…` screen is never shot.
- **Stage C (then assert):** golden diff with a **block-density** rule — fail
  when any 60x60 block exceeds 40% of pixels above 8/255 — not a whole-frame
  pixel budget. Measured noise is 0.75–0.80% of the frame; a clipped label is
  ~0.05%, so any global threshold that is stable is also blind.
- **Ship now, independent of both:** the reviewed contact sheet at `medium` and
  `accessibility-extra-large`. That is where the value is today.

## Deep-link scheme — resolved

`app.json` declares `"scheme": "mobile"`, but only **`com.tesserix.kora://`**
works unattended. `mobile://` triggers an iOS *"Open in "Kora"?"* system alert
that blocks navigation and lands in the screenshot. `shots.mjs` defaults to
`com.tesserix.kora`.

**14/14 declared routes reachable by deep link**, signed in, at both content
sizes, with no tapping.

## Constraints honoured

- No app source modified.
- No images committed; `.shots/` gitignored.
- No assertions, no goldens, no CI wiring.
- Test account `ss1@kora.test` created for the authenticated captures and
  **deleted via the app's own delete-account flow**; simulator content size
  restored to `medium`.
