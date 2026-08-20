---
quick_id: 260820-sgl
slug: shots-goldens
date: 2026-08-20
refs: kora#257 (Stage C), kora#272, kora#262
status: done — comparator, golden path and 13 goldens landed; NOT wired into CI
---

# Stage C — golden-image comparison for the screenshot harness

## Headline

**The rule Stages A and B decided on — block density above a threshold — does
not catch the bug this harness was built for.** Measured: deleting one
character from a card title moves 38 pixels and fills 9.0% of its densest
block, while the residual noise fills 14-26% of a block. Any density threshold
set above the noise passes the defect, at either storage scale.

So the shipped rule is a **strict pixel budget** — zero pixels may differ by
more than 48/255 at the 1x scale goldens are stored at — with the block-density
rule kept as a secondary net and a third rule for broad, faint shifts. That is
possible because of the downsampling measurement below: at 1x with a 48/255
threshold, **13 of the 15 routes differ by exactly zero pixels across six
launches.**

13 routes have goldens. `tab-today` and `capture` are excluded with measured
reasons. Total committed: **1.96 MB.**

---

## 1. The downsampling measurement (1x vs 3x)

Six launches of `medium` on iPhone 17 Pro Max / iOS 26.2, readiness gate on,
clock pinned, dev-menu FAB off, `--relaunch-each-repeat`. Worst pair per route.
The 3x frame is 1320x2868; 1x is 440x956, box-averaged 3x3.
A 60x60 block at 3x is 20x20 at 1x, so both columns measure the same region.

### The hypothesis was wrong, and usefully so

| route (3x -> 1x) | max delta | px > 8/255 | densest block @ 8/255 |
| ---------------- | --------- | ---------- | --------------------- |
| tab-today        | 101 -> **36** | 7,147 -> 1,010 | 13.0% -> **23.0%** |
| tab-diary        | 103 -> **36** | 21,342 -> 2,658 | 12.3% -> **22.5%** |
| tab-progress     | 96 -> **34**  | 11,201 -> 1,956 | 10.0% -> **17.0%** |

**Downsampling does not suppress the BlurView drift at a fixed threshold — it
concentrates it.** A 3x3 source block holding one strongly-differing pixel
averages to one output pixel that still differs by ~11/255, so the *count*
falls by ~8x while the *area* falls by 9x, and the density of pixels counted as
differing goes UP. Block density is roughly 1.8x worse at 1x than at 3x.

What downsampling does deliver is an **amplitude ceiling**. The averaging
divides the drift's amplitude by up to 9, and across six launches no route
exceeded **36/255** at 1x (against ~100/255 at 3x). That ceiling is worth far
more than the density, because it makes a *strict* rule possible.

### Noise vs threshold, at 1x, all 15 routes, worst of every pair

| route | px > 8/255 | frame % > 8 | px > 48/255 | densest block @ 48 |
| ----- | ---------- | ----------- | ----------- | ------------------ |
| tab-today | 9,179 | 2.182% | **634** | 16.3% |
| tab-diary | 2,658 | 0.632% | **0** | 0.0% |
| tab-progress | 1,956 | 0.465% | **0** | 0.0% |
| capture | 1,286 | 0.306% | **0** † | 0.0% |
| the other 11 | 0 | 0.000% | **0** | 0.0% |

† 0 across the pairs in this run; a later golden-vs-candidate comparison found
4. See the exclusions.

### Recommended configuration, and the arithmetic behind it

**Store at 1x, threshold 48/255, pixel budget 0.** Secondary: block 20px at 30%
density; broad rule 3% of frame above 8/255.

- **Block/threshold arithmetic in 1x space.** The block halves in linear size
  (60 -> 20) so it covers the same screen region and Stage B's density figures
  carry over. The threshold does NOT carry over: 8/255 at 3x behaves like
  ~32-48/255 at 1x. Equivalence, measured on tab-today: 3x @ 8 gives 14.3%
  density, 1x @ 32 gives 16.8%, 1x @ 48 gives 13.5%. **1x with a 48/255
  threshold is the closest equivalent of 3x with an 8/255 threshold** — and the
  defect signal is the same at both (41.6% vs 40.8% block density for a 2pt
  padding change).
- **Why not keep 30%-density as the primary rule.** With a 30% threshold the
  margins are: 3x@8 -> noise 14.3% (2.1x below) but the one-character label edit
  at 7.8% never fires; 1x@8 -> noise 26.3%, only 1.14x below the rule, which
  would flake. Neither is a suite worth having.
- **Why the strict budget is safe.** At 1x@48 thirteen routes measure zero
  differing pixels across six launches, so a budget of 0 has no false-positive
  surface at all — verified twice end to end (section 2).
- **What the strict budget gives up, and what covers it.** A threshold of
  48/255 is blind to a faint, broad change (a colour token moving a few
  levels). That is the third rule: more than 3% of the frame above 8/255 fails.
  Measured noise on the routes that have goldens tops out at 0.632%, so the
  margin is 4.7x.

**Size.** 3x is ~1.7MB per route, ~25MB per content size, rewritten in full by
every intentional UI change and kept forever by git — against a `.git` that is
currently 102MB. 1x is ~150KB per route. The committed set is **1.96 MB**.
Size alone would not have decided this; the amplitude ceiling did. Size decided
the tie.

---

## 2. The deliberate-regression test

An unfalsified comparator is worthless, so the comparator was run against a
build with two deliberate defects, both reverted afterwards.

| change | file | what it models |
| ------ | ---- | -------------- |
| `paddingHorizontal: 20` -> `24` | `app/settings.tsx:75` | a 4pt layout regression |
| `"Open Food Facts"` -> `"Open Food Fact"` | `app/about.tsx:46` | one character clipped off a label — the #257 bug class |

**Result: FAIL, exit 1, on exactly those two routes and no others.**

```
about            211       38    0.012 140,440 20x20            9.0%   FAIL
settings         255    10191    4.907 40,660 20x20            35.0%   FAIL
  about: 38 pixel(s) differ beyond the threshold
  settings: 10191 pixel(s) differ beyond the threshold; 5 block(s) over 30%
            density; 4.907% of the frame shifted faintly, budget 3%
    block 40,660 20x20 — 35.0% (140/400 px) at 3x: 120,1980 60x60
```

The other 11 routes stayed `ok` with zero differing pixels, so this is not a
comparator that fails everything.

**`about` is the important row.** Its densest block is **9.0%** — a
block-density rule at 30%, or at any threshold above the 14-26% noise floor,
would have passed it. Only the pixel budget caught it. That single measurement
is why the rule shipped is not the one the plan specified.

Before the regression: **13/13 ok, exit 0** (11 routes with literally zero
differing pixels). After reverting both edits and re-capturing: **13/13 ok,
exit 0** again.

---

## 3. Routes with goldens, and routes without

**13 with goldens:** `about`, `ai-usage`, `coach`, `feedback`, `notifications`,
`onboarding`, `profile`, `recipes`, `settings`, `sign-in`, `tab-diary`,
`tab-more`, `tab-progress`.

Note that `coach`, `ai-usage`, `notifications` and `profile` — the routes
#272's report flagged as the noisiest — are now byte-identical across launches.
Stage B's readiness gate did that, and this signed-in account is new, so those
screens render settled empty states rather than a race between loading and
data. If they acquire content they may need re-measuring.

**2 excluded, with the reason recorded in `scripts/shots.goldens.mjs` and
echoed by every comparator run:**

- **`tab-today`** — the GlassPanel/BlurView backdrop re-samples per launch.
  Stage B showed an 8000ms dwell does not help and the route is bimodal. Up to
  **634 pixels above 48/255**, densest block 16.3%. A budget large enough to
  absorb that (~2000px) is ~50x the 38-pixel signal of a one-character label
  change, so it would keep the route green while blinding it to the bug class
  the harness exists for. **Excluded rather than weakened.**
  To bring it back: make the blur deterministic, render it flat under a capture
  flag, or seed the backdrop.
- **`capture`** — the greeting bubble's entrance settles one to three device
  pixels lower on some launches. Its per-route dwell was raised to 8000ms
  (which cut the residual from a 212/255 max delta to 34) but did not close it:
  0-4 pixels above 48/255, up to 1,286 above 8/255. Same argument as above.
  To bring it back: gate on whatever the bubble's entrance waits for — the
  current gate opens on the mode chips, which mount well before it.

---

## 4. What was built

| file | role |
| ---- | ---- |
| `scripts/shots-compare.mjs` | the comparator. Takes a golden dir and a candidate dir, exits non-zero, names the route and the failing block in both golden and capture coordinates. |
| `scripts/shots-golden.mjs` | the capture/update path. `npm run shots:golden` captures fresh (with `--strict-render`) and promotes; `--from <dir>` promotes an existing capture. |
| `scripts/shots-blocks.mjs` | the rules, as pure functions over a delta map. No ImageMagick, no files — unit-testable. |
| `scripts/shots-image.mjs` | the two magick operations both halves must perform identically: the 3x->1x box downsample and the max-channel delta map. |
| `scripts/shots.goldens.mjs` | every number the verdict rests on, and the exclusion list with reasons. |
| `scripts/__tests__/shots-blocks.test.mjs` | 10 tests, asserting against the SHIPPED constants so loosening one breaks a test that says why it existed. `npm run shots:test`. |
| `shots-golden/medium/*.png` | 13 goldens + `manifest.json` + `README.md`. |

Deltas are counted in JS from a raw grayscale buffer rather than by an
ImageMagick `-resize` down to a block grid: exact per-block counts, no
dependence on IM's filter/gamma semantics, and testable against synthetic
buffers.

### Refusals, which are the load-bearing part

`shots-golden.mjs` will not write a golden for a route that never became ready,
that carries a `renderErrors` LogBox marker, that landed on the sign-in wall,
or that is excluded — and will not write anything at all from a capture with no
clock pin. There is no `--force`.

`shots-compare.mjs` refuses to compare a candidate with any not-ready route, any
render error, any system banner (below), no clock pin, a different clock pin, a
different content size or a different device. **A captured route with neither a
golden nor an exclusion is an error**, as is a golden with no candidate — a
narrowed `--routes` run cannot masquerade as a full comparison.

### Two harness fixes found along the way

1. **The dev client's blue "Refreshing…" banner** (`shots.mjs`). Two of 54
   captures had it, costing one route 8.5% of the frame with a 100%-dense
   block — an instant spurious failure. Like iOS's "Use Strong Password?"
   sheet it renders in another process and is invisible to `idb ui
   describe-all`, and its text collides with real copy (`coach` says
   "Refreshing today's focus…"), so a text marker cannot work. The image can:
   the banner paints saturated system blue across a band where this app is
   always very dark. Now detected per shot, reported in the manifest, and
   refused by both the golden path and the comparator.
2. **`capture` needed a longer dwell** (`shots.routes.mjs`): `settle: 8000`,
   with the measurement in the comment. It is still excluded, but the residual
   is now small enough to be worth naming.

`shots-noise.mjs` gained `--downscale N` and an exact `blockDens%` column
computed by the same module the comparator uses, so section 1 is reproducible:

```
node scripts/shots-noise.mjs --downscale 3 .shots/<dir>
```

---

## 5. Not done, deliberately

- **Not wired into CI.** kora#262's macos-26 runner makes it possible; it needs
  a booted iPhone 17 Pro Max, a dev client, Metro and a signed-in simulator,
  and that is a separate decision with its own cost.
- **Only `medium`.** `accessibility-extra-large` would double the set and has
  not been measured under these rules. `contentSizes` in `shots.goldens.mjs`
  is the place to add it.
- **Fixture data still not used** (Stage B item 3). These goldens are of a
  freshly-created, empty account against prod. That is stable today; a route
  that gains content will need its golden re-taken.

## 6. Environment left as found

Content size `medium`; the throwaway account (`shotc1@kora.test`) deleted
through the app's own delete-account flow and confirmed; the dev-menu FAB
preference restored for interactive use; my Metro on 8083 stopped; the
pre-existing Metro on 8081 and 8082 untouched; every `.shots/` directory from
this session removed. `.shots/` remains gitignored; `apps/mobile/shots-golden/`
is the new committed location.

## 7. Verification

- Full jest suite: **207 suites / 1814 tests pass**.
- `node --test scripts/__tests__/*.test.mjs`: **10/10 pass**.
- `npx eslint` on all nine harness scripts: clean. (Prettier deliberately not
  run — this repo has no prettier config and it is not the project's formatter.)
- Comparator: green (13/13, exit 0) -> red on two deliberate defects (exit 1) ->
  green again after revert (13/13, exit 0), each from a fresh capture.
