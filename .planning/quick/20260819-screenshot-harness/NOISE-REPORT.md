# Screenshot harness: noise floor, and what kora#257 should assert

Measured 2026-08-19 on iPhone 17 Pro Max (`8B6D805C-…`), iOS 26.2, dev client
against prod (`https://kora-api.tesserix.app`). Frame is 1320x2868 = **3,785,760
pixels**. Four runs, 14 routes each, 3 passes each = 168 captures.

Everything below is the **worst pair of the three passes** for each route.
`>N` = pixels whose largest per-channel delta exceeds N/255. Reproduce with:

    node scripts/shots.mjs --content-size medium --out .shots/medium-inlaunch --repeat 3
    node scripts/shots.mjs --content-size medium --out .shots/medium-relaunch --repeat 3 --relaunch-each-repeat
    node scripts/shots-noise.mjs .shots/medium-inlaunch .shots/medium-relaunch

---

## Headline

**Rendering is essentially deterministic. The noise is app state, not pixels.**

|                              | within one launch | across launches               |
| ---------------------------- | ----------------- | ----------------------------- |
| routes bit-identical (of 14) | 9 (medium) / 6 (axl) | 9 (medium) / 9 (axl)       |
| worst max per-channel delta  | **2 / 255**       | **255 / 255**                 |
| worst pixels above 8/255     | **0**             | **1,810,500** (47.8% of frame)|
| worst pixels above 4/255     | **0**             | 1,840,135                     |

Not a single pixel in any of the 84 within-launch comparisons exceeded 4/255.
Every large across-launch number traces to one of two named causes, and neither
is antialias noise.

This **contradicts the ~3,933-pixels-above-threshold figure quoted in the plan**.
That measurement was almost certainly an across-launch comparison of a
data-backed screen, and it was measuring app state, not the renderer.

---

## 1. Within one launch — the renderer is stable

Repeat captures of the same route inside a single app launch, re-navigating by
deep link each time.

### medium

| route         | maxΔ | >0  | >4 | >8 | diff% |
| ------------- | ---- | --- | -- | -- | ----- |
| about         | 1    | 6   | 0  | 0  | 0.000 |
| tab-today     | 1    | 111 | 0  | 0  | 0.000 |
| tab-more      | 2    | 95  | 0  | 0  | 0.000 |
| tab-progress  | 2    | 108 | 0  | 0  | 0.000 |
| tab-diary     | 2    | 879 | 0  | 0  | 0.000 |
| other 9 routes| 0    | 0   | 0  | 0  | 0.000 |

### accessibility-extra-large

| route         | maxΔ | >0    | >4 | >8 | diff% |
| ------------- | ---- | ----- | -- | -- | ----- |
| recipes       | 1    | 5,790 | 0  | 0  | 0.000 |
| notifications | 1    | 5,376 | 0  | 0  | 0.000 |
| tab-diary/more/progress | 1 | 4,575 each | 0 | 0 | 0.000 |
| profile       | 1    | 211   | 0  | 0  | 0.000 |
| other 6 routes| 0    | 0     | 0  | 0  | 0.000 |

**Worst case within a launch: 879 pixels (0.023% of the frame) differing by
2/255.** That is one least-significant-bit of rounding on glyph edges. It is
invisible and it is below any threshold worth setting.

---

## 2. Across launches — two causes, both nameable

### medium, relaunching between passes

| route        | maxΔ | >0        | >8      | >32     | diff%  | blocks% | topBlock% |
| ------------ | ---- | --------- | ------- | ------- | ------ | ------- | --------- |
| coach        | 255  | 1,478,094 | 911,511 | 620,544 | 24.077 | 36.2    | 1.4       |
| tab-today    | 71   | 154,253   | 30,316  | 5,406   | 0.801  | 24.5    | 2.1       |
| tab-progress | 96   | 131,525   | 29,572  | 5,644   | 0.781  | 32.1    | 1.4       |
| tab-diary    | 103  | 108,811   | 28,331  | 12,090  | 0.748  | 27.5    | 1.4       |
| onboarding   | 1    | 5,791     | 0       | 0       | 0.000  | 0.0     | 0.0       |
| other 9      | 0    | 0         | 0       | 0       | 0.000  | 0.0     | 0.0       |

### accessibility-extra-large, relaunching between passes

| route         | maxΔ | >8        | diff%  | blocks% | topBlock% |
| ------------- | ---- | --------- | ------ | ------- | --------- |
| ai-usage      | 243  | 1,810,500 | 47.824 | 57.9    | 1.7       |
| coach         | 242  | 1,336,585 | 35.306 | 46.1    | 1.0       |
| profile       | 226  | 359,219   | 9.489  | 27.1    | 1.0       |
| notifications | 244  | 183,964   | 4.859  | 20.9    | 1.5       |
| recipes       | 225  | 154,192   | 4.073  | 19.7    | 1.5       |
| other 9       | 0    | 0         | 0.000  | 0.0     | 0.0       |

### Cause A — app state (all the maxΔ ≈ 255 rows)

These are **not rendering differences. They are pictures of different screens.**

- `coach` medium: pass 3 showed *"Couldn't refresh today's focus — Retry"* and
  *"I couldn't load your earlier conversation — Retry"*. Two error rows appear,
  everything below shifts down ~90px, and every glyph below the shift differs
  completely. Hence maxΔ 255 over 24% of the frame.
- `ai-usage` / `profile` / `recipes` / `notifications` at axl: passes 1 and 2
  were **bit-identical to each other** and showed *"Loading…"* / *"Couldn't load
  your recipes"* / *"Couldn't load your profile"*; pass 3 showed loaded data.
  Pairwise: `1v2` = 0 differing pixels, `1v3` = `2v3` = the full number above.

A fixed `--settle` timer plus a live backend does not produce a repeatable
screen. **No pixel tolerance can absorb this** — the difference is 250/255 over
half the frame, and it is a semantically different screen.

Worth flagging separately: in the axl across-launch run **all four tabs were
bit-identical across all three launches — because all three showed "Couldn't
load your profile / Retry".** A 0.000% diff figure can mean "perfectly stable"
or "consistently broken". Do not read stability numbers without looking at the
image.

### Cause B — sub-pixel layer origin drift (the maxΔ 71–103 rows)

`tab-today` / `tab-diary` / `tab-progress` at medium showed the same content
across launches, yet ~30,000 pixels (0.75–0.80% of frame) differed above 8/255.
Characterising it:

- **Not a whole-pixel shift.** Rolling one image by ±1 and ±2 px only made it
  worse (dy=0 → AE 1,605 at fuzz 3%; dy=±1 → 13,316 / 15,753).
- **It is a sub-pixel shift.** Re-testing at quarter-pixel steps, the minimum is
  at **dy = +0.25 device px** (≈1/12 pt), which cuts pixels-above-8 on the card
  region from 26,022 to 16,390 — a 37% reduction. The residual is rasterisation
  variance around that offset.
- **Edge-only.** Flat fills are bit-identical: sampling the card background at
  six points gives exactly the same RGB in both launches — e.g. `(98,21,24)` vs
  `(98,21,24)`. The differing pixels are glyph and stroke edges, e.g.
  `(195,167,169)` vs `(243,238,238)` on a text antialias edge.
- **Spatially scattered, which is the diagnostic that matters.** 24–32% of a
  22x48 grid contains some differing pixel, but the densest single block holds
  only **1.4–2.1%** of them. In absolute terms the worst block holds ~640 of
  30,316 pixels in a 60x60 block — about **18% block density**.

Only the four screens with a large composited card drift; every flat/list screen
(`about`, `settings`, `sign-in`, `feedback`, `tab-more`, …) is **bit-identical
across launches**.

---

## 3. Environment artefacts that must go before any golden is committed

1. **The stale dev client lacks `expo-linear-gradient`.** Every affected screen
   carries red LogBox *"Unimplemented component:
   `<ViewManagerAdapter_ExpoLinearGradient>`"* overlays that sit on top of real
   content (`tab-today`, `tab-diary`, `tab-progress`, `tab-more`, `coach`,
   `ai-usage`). Any golden captured now enshrines the overlay.
2. **The `expo-dev-menu` FAB.** The draggable gear appears in the top-right of
   every one of the 168 captures. It did **not** move during this session, so it
   contributed nothing to the numbers above — but its position lives in
   `UserDefaults` and survives reinstalls, so it moves between sessions and
   machines. It sits *over app content* (it overlaps the notification bell on
   `tab-today` and the settings affordance on every stack screen), so masking a
   fixed rectangle would also mask real UI, and masking a *moving* rectangle is
   not possible from the image alone. **Do not mask it — remove it**, by
   capturing from a build with the dev menu disabled, or a preview/release
   build.

Both are fixed by the same action: capture against a purpose-built capture
client rather than the stale dev client.

---

## 4. What a diff would and would not have caught

The plan lists three motivating bugs. All three are "the rendered image is
wrong", and a golden diff catches all three.

But this run also surfaced four layout bugs **that no golden diff would ever
report**, because they are present in every capture and a golden would enshrine
them as correct:

| screen        | content size | defect |
| ------------- | ------------ | ------ |
| `onboarding`  | **medium**   | goal TickRuler right label truncated to **"Build m"** — the exact #257 motivating bug class, still live at the default content size |
| `feedback`    | axl          | title breaks mid-word: **"Send feedbac / k"** |
| `notifications` | axl        | title breaks mid-word: **"Notificat / ions"** |
| `settings`    | axl          | reminder row label breaks mid-word: **"Breakf / ast"** |

**Diffing catches regressions. It does not catch existing wrongness.** Right now
the app has more of the latter than the former, and the cheapest instrument for
it is a human looking at a contact sheet — which needs no assertions at all.

---

## 5. Recommendation for kora#257

### Do not commit goldens yet — but not because the renderer is noisy

The renderer is fine. The blocker is that **the same route does not reliably
render the same screen**, because app state depends on a live network. Tolerance
tuning cannot fix a 250/255 delta over half the frame. Fix determinism first:

**Stage B — make capture deterministic (prerequisite, do this next)**

1. Build a capture client that includes `expo-linear-gradient` and has the dev
   menu disabled. Removes both environment artefacts at once.
2. Point the harness at seeded, deterministic data — a fixture server or
   recorded responses — not prod.
3. Replace the fixed `--settle` timer with a readiness gate. A screen that is
   still `Loading…` or showing `Retry` must not be shot; the harness should
   retry or record the route as `not-ready` in the manifest. This alone would
   have removed every maxΔ≈255 row in section 2.

**Stage C — then assert, using block density, not a global pixel count**

Once Stage B lands, assert against goldens with a **spatially-concentrated**
rule rather than a whole-frame pixel budget. The data says why:

- A whole-frame budget cannot work. Measured across-launch residual on the
  noisiest real screens is **0.75–0.80% of the frame**. A clipped end label like
  "Build m" is roughly 60x30 px ≈ **0.05% of the frame** — 15x *smaller* than
  the noise. Any global threshold loose enough to be stable is loose enough to
  hide the bug this harness exists to catch.
- A block-density rule separates them cleanly. Noise peaks at **~18% density in
  its worst 60x60 block** (topBlockShare 1.4–2.1% of ~30,000 pixels). A clipped
  or displaced label concentrates ~1,800 pixels into one or two blocks — **>50%
  density**. That is a ~3x margin.

Concretely: **fail when any 60x60 block has more than 40% of its pixels above a
per-channel delta of 8/255.** Report, but do not fail on, the global count.

**Stage A′ — ship the contact sheet now, independent of all of the above**

Section 4 is the strongest argument in this report. Four real layout defects
were found by *looking* at 28 images, and a golden suite would have hidden every
one. Publish the contact sheet at `medium` and `accessibility-extra-large` as a
reviewable artefact from day one and treat it as the primary deliverable.
Assertions are a later, secondary layer.

### Do not

- Do not commit `.shots/` (already gitignored).
- Do not adopt crop-limited diffing as the primary strategy. Cause B is
  frame-wide on card screens, so cropping does not isolate it, and cropping
  would also blind the suite to exactly the edge-of-container clipping that
  motivated #257.
- Do not wire this into CI before Stage B. The macos-26 runner from kora#262
  makes it possible; the live-network nondeterminism above makes it useless.

---

## 6. Route reachability by deep link

`app.json` declares `"scheme": "mobile"`, but the built `Info.plist` registers
both `mobile` and `com.tesserix.kora`. They do **not** behave the same:

- **`com.tesserix.kora://<route>` — use this.** Navigates silently and
  immediately.
- **`mobile://<route>` — unusable for unattended capture.** iOS interposes an
  *"Open in "Kora"?" Cancel / Open* system alert, which blocks navigation and
  lands in the screenshot.

All 14 declared routes were reachable, signed in, at both content sizes —
**14/14, no failures, no route needing a tap.**

| route | path | reached |
| ----- | ---- | ------- |
| sign-in | `/sign-in` | yes |
| onboarding | `/onboarding` | yes (reachable even while signed in) |
| tab-today | `/` | yes |
| tab-diary | `/diary` | yes |
| tab-progress | `/progress` | yes |
| tab-more | `/more` | yes |
| recipes | `/recipes` | yes |
| settings | `/settings` | yes |
| profile | `/profile` | yes |
| notifications | `/notifications` | yes |
| about | `/about` | yes |
| coach | `/coach` | yes |
| ai-usage | `/ai-usage` | yes |
| feedback | `/feedback` | yes |

Not attempted, and worth adding once Stage B gives them deterministic data:
`/log`, `/friends`, `/groups`, `/reminders`, `/delete-account`, the
`presentation: modal` routes `/meal` and `/capture`, and the dynamic routes
`/recipe/[id]`, `/group/[id]`, `/challenge/[id]`.

`--content-size accessibility-extra-large` reflows correctly, confirming the
set-then-relaunch order in `shots.mjs` is required and works: the same
`settings` route goes from a compact list to a two-line-per-row layout.
