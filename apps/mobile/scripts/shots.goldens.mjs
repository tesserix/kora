/**
 * shots.goldens.mjs — where goldens live, what they are compared with, and
 * which routes are DELIBERATELY not compared at all.
 *
 * One file, so that every number the pass/fail decision rests on is in one
 * place and moving one is a reviewable diff rather than a flag someone passed
 * on the command line at 1am.
 *
 * Everything here was measured on 2026-08-20 against 6 launches of `medium` on
 * an iPhone 17 Pro Max (iOS 26.2), plus two deliberately regressed builds. The
 * measurements are in .planning/quick/20260820-shots-goldens/SUMMARY.md.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const GOLDEN = {
  /** Committed golden root, relative to apps/mobile. */
  dir: "shots-golden",

  /**
   * Goldens are stored at 1x — box-averaged 3x3 down from the simulator's
   * native 3x capture — and every candidate goes through the identical
   * downsample before comparison.
   *
   * MEASURED, because the obvious reason to do this turned out to be wrong.
   *
   * The hoped-for reason was noise suppression: averaging 3x3 should wash out
   * the 1-LSB BlurView drift Stage B characterised. It does suppress the
   * AMPLITUDE — the worst across-launch delta falls from ~100/255 at 3x to
   * ~36/255 at 1x, a hard ceiling — but it INCREASES the density of pixels
   * counted as differing at a fixed 8/255 threshold, because a 3x3 block
   * containing one strongly-differing pixel averages to one output pixel that
   * still differs by ~11. Measured on tab-today, the densest 60x60-equivalent
   * block went from 14.3% at 3x to 26.3% at 1x. Downsampling concentrates
   * scattered noise; it does not remove it.
   *
   * What it does give is a clean amplitude ceiling, and that is worth more
   * than the density: with the threshold set above that ceiling (see
   * `threshold`), 14 of 15 routes measure ZERO differing pixels across six
   * launches, which permits a far stricter rule than any density budget.
   *
   * The size argument then decides the rest: 3x is ~1.7MB per route (~25MB per
   * content size, against a .git that is currently 102MB, rewritten in full by
   * every intentional UI change and kept forever). 1x is ~2.5MB.
   */
  scale: 3,

  /**
   * Per-channel delta, of 255, above which a pixel counts as differing —
   * applied to the 1x image.
   *
   * 48 is not a tolerance, it is the amplitude ceiling of the residual noise
   * plus margin. Across six launches at `medium` the largest across-launch
   * delta on any route was 36/255 at 1x, and at 48 fourteen of fifteen routes
   * differ by ZERO pixels. That is what makes `maxPixels: 0` below possible,
   * and a rule that fires on a single pixel is worth much more than a
   * percentage budget: it catches a one-character label change, which no
   * density rule at any workable threshold does (measured: deleting one
   * character from a card title moved 38 pixels, filling 9.0% of its block —
   * a density rule set anywhere above the noise would sail straight past it).
   *
   * In physical terms a pixel over this threshold means a 3x3 device-pixel
   * region whose average changed by more than 19%. Nothing that survives that
   * is invisible.
   */
  threshold: 48,

  /**
   * Pixels above `threshold` a route may differ by before it fails.
   *
   * Zero, for every route. See `ROUTE_BUDGET` for the escape hatch and why
   * nothing currently uses it.
   */
  maxPixels: 0,

  /**
   * The comparison block, in GOLDEN-space pixels. 20 at 1x covers the same
   * region of the screen as the 60 device pixels Stages A and B measured
   * against, so their published figures carry over unchanged.
   */
  block: 20,

  /**
   * Block-density rule: fail when any block has more than this share of its
   * pixels differing.
   *
   * 30%, per Stage B's recommendation — measured noise peaked at 20.1% of a
   * 60x60 block there and 16.3% here, and a displaced block of content fills
   * 33-49%.
   *
   * IMPORTANT, AND NOT WHAT #257's PLAN ASSUMED: this rule is a SAFETY NET,
   * not the primary check, and it is unreachable while `maxPixels` is 0. It is
   * kept because it is the right tolerance mechanism the moment any route is
   * granted a budget, and because it fails a gross layout break independently
   * of the pixel count. It is NOT sufficient on its own: text is thin, so a
   * small label edit changes far too few pixels to fill 30% of a block. That
   * measurement is the reason the primary rule is a pixel budget instead.
   */
  failDensity: 0.3,

  /**
   * Broad-shift rule: fail when more than this share of the FRAME differs by
   * more than 8/255 — a much lower bar than `threshold`.
   *
   * This is what catches a change too faint for the threshold above: a colour
   * token moving by a few levels across a whole card is invisible to a 48/255
   * cut-off and to any block-density rule, but it moves a large fraction of
   * the frame. Measured across-launch noise at 8/255 on the routes that have
   * goldens: 0.632% (tab-diary), 0.465% (tab-progress), 0.306% (capture), and
   * exactly 0.000% on the other eleven. 3% leaves 4.7x over the worst.
   */
  broadThreshold: 8,
  broadFramePct: 3,

  /** Content sizes that have committed goldens. */
  contentSizes: ["medium"],
};

/**
 * Per-route overrides of `maxPixels`.
 *
 * DELIBERATELY EMPTY. A budget here buys tolerance by giving up exactly the
 * sensitivity that makes this suite worth running — with a budget of N, no
 * change smaller than N pixels can ever be detected on that route — so the
 * only honest way to add one is to measure the route's noise first and write
 * the number and the measurement in the comment. If the budget you need is
 * larger than the defect you are trying to catch, the route belongs in
 * EXCLUDED instead. That is the trade `tab-today` lost.
 */
export const ROUTE_BUDGET = {
  medium: {},
};

/**
 * The shape of the defect this harness was built for, in golden-space pixels:
 * kora#257's goal-ruler end label clipped to "Build m", roughly 60x30 device
 * pixels at 3x. Used by the unit tests.
 */
export const DEFECT_SHAPE = { width: 20, height: 10 };

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

/**
 * Routes that are captured and reviewable but NOT asserted against a golden,
 * with the reason recorded here rather than in someone's memory.
 *
 * This list exists because the alternative is worse. A route that will not sit
 * still can always be made to pass by widening its budget — and a budget
 * widened until everything passes is a suite that reports "green" while the
 * bug it was built for walks through it. Stage A's finding was exactly that:
 * a green run in which all three passes showed "Couldn't load your profile".
 *
 * An entry here is a debt with a name, and each one says what would remove it.
 */
export const EXCLUDED = {
  medium: {
    capture:
      "The greeting bubble's entrance settles at a slightly different vertical " +
      "offset on each launch — visibly one to three device pixels — and the " +
      "route's per-route 8000ms dwell (shots.routes.mjs) reduces it without " +
      "removing it: measured residuals across launches range from 0 to 4 pixels " +
      "above 48/255 and up to 1,286 above 8/255. That upper bound is the same " +
      "order as the 38-pixel signal of a one-character label change, so any " +
      "budget that absorbs the drift also hides the defect. " +
      "To bring it back: find what the bubble's entrance is waiting on — the " +
      "gate opens on the mode chips, which mount well before it — and gate on " +
      "that instead, or disable its entrance under a capture flag.",
    "tab-today":
      "Not deterministic across launches, and the only route that is not. " +
      "GlassPanel renders an expo-blur BlurView whose backdrop re-samples per " +
      "launch; Stage B showed an 8000ms dwell does not help and that the route " +
      "is bimodal (0.113% and 1.101% of frame under identical settings). " +
      "Measured here over six launches: up to 634 pixels above 48/255 at 1x, " +
      "in a block 16.3% dense. A budget large enough to absorb that (~2000px) " +
      "is roughly FIFTY TIMES the 38-pixel signal of a one-character label " +
      "change, so it would keep the route green while blinding it to the bug " +
      "class this harness exists for. Excluded rather than weakened. " +
      "To bring it back: make the blur deterministic, or render it flat under " +
      "a capture flag, or seed the backdrop — then delete this entry and run " +
      "`npm run shots:golden`.",
  },
};

/** Reason a route is excluded at this content size, or null. */
export function exclusionFor(contentSize, route) {
  return EXCLUDED[contentSize]?.[route] ?? null;
}

/** Pixel budget for a route: its override, or the strict default. */
export function budgetFor(contentSize, route) {
  return ROUTE_BUDGET[contentSize]?.[route] ?? GOLDEN.maxPixels;
}
