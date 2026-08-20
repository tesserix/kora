/**
 * Unit tests for the golden comparison rules.
 *
 * Run with the Node test runner, not jest — these are ESM scripts outside the
 * app bundle and jest-expo's transform does not pick up `.mjs`:
 *
 *   npm run shots:test
 *
 * The point of testing this at all: these rules are the only thing standing
 * between "the screenshots changed" and "the build is fine", and a rule that
 * silently never fires is indistinguishable from a passing suite. The cases
 * that matter most are at the bottom, and they are asserted against the
 * SHIPPED numbers imported from shots.goldens.mjs rather than local copies —
 * so loosening a threshold breaks a test that says why it existed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { blockDensities, judge } from "../shots-blocks.mjs";
import { GOLDEN, DEFECT_SHAPE } from "../shots.goldens.mjs";

const WIDTH = 100;
const HEIGHT = 100;
const BLOCK = GOLDEN.block;
const THRESHOLD = GOLDEN.threshold;

/** The shipped rules, so these tests move when the shipped numbers move. */
const RULES = {
  maxPixels: GOLDEN.maxPixels,
  failDensity: GOLDEN.failDensity,
  broadFramePct: GOLDEN.broadFramePct,
};

// Uint8Array rather than Buffer: what magick hands the comparator IS a Buffer,
// but nothing in the rule depends on that, and saying so here keeps it true.
function blank() {
  return new Uint8Array(WIDTH * HEIGHT);
}

const opts = {
  width: WIDTH,
  height: HEIGHT,
  block: BLOCK,
  threshold: THRESHOLD,
  broadThreshold: GOLDEN.broadThreshold,
};

test("identical images produce no blocks at all", () => {
  const report = blockDensities(blank(), opts);
  assert.equal(report.blocks.length, 0);
  assert.equal(report.worstBlock, null);
  assert.equal(report.aboveThreshold, 0);
  assert.equal(report.maxDelta, 0);
});

test("deltas at or below the threshold are counted as differing but never as density", () => {
  const delta = blank();
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) delta[i] = THRESHOLD; // exactly at the cut-off
  const report = blockDensities(delta, opts);
  assert.equal(report.differing, WIDTH * HEIGHT);
  assert.equal(report.aboveThreshold, 0);
  assert.equal(report.blocks.length, 0, "a frame-wide 1-LSB shift must not create a block");
});

test("density is measured per block, not over the frame", () => {
  const delta = blank();
  // 200 pixels, all inside the block at (0,0): 200/400 = 50%.
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 20; x += 1) delta[y * WIDTH + x] = 255;
  const report = blockDensities(delta, opts);
  assert.equal(report.worstBlock.density, 0.5);
  assert.equal(report.worstBlock.x, 0);
  assert.equal(report.worstBlock.y, 0);
  assert.equal(report.blocks.length, 1);
  // The same 200 pixels are only 2% of the frame — which is why the global
  // number must not be the thing that decides.
  assert.equal(report.diffPct, 2);
});

test("short edge blocks are measured over their real area, not padded", () => {
  // 90 wide so the last column of blocks is 10px, 100 tall so rows divide.
  const width = 90;
  const delta = new Uint8Array(width * HEIGHT);
  // Fill the top-right 10x10 corner — the whole of the short block at (80,0).
  for (let y = 0; y < 10; y += 1) for (let x = 80; x < 90; x += 1) delta[y * width + x] = 255;
  const report = blockDensities(delta, { ...opts, width });
  const corner = report.blocks.find((b) => b.x === 80 && b.y === 0);
  assert.equal(corner.area, 200, "10 wide x 20 tall");
  assert.equal(corner.density, 0.5);
});

test("a mismatched delta length is an error, not a silently wrong verdict", () => {
  assert.throws(() => blockDensities(new Uint8Array(10), opts), /expected/);
});

test("an identical frame passes every shipped rule", () => {
  const report = judge(blockDensities(blank(), opts), RULES);
  assert.equal(report.pass, true);
  assert.deepEqual(report.reasons, []);
});

test("the shipped pixel budget is zero, so one strongly differing pixel FAILS", () => {
  // This is the property a density budget cannot have, and the reason the
  // primary rule is a pixel count: a one-character label edit moved 38 pixels
  // and filled only 9% of its block.
  const delta = blank();
  delta[42 * WIDTH + 42] = 200;
  const report = judge(blockDensities(delta, opts), RULES);
  assert.equal(report.pass, false);
  assert.match(report.reasons[0], /1 pixel\(s\) differ/);
});

test("noise below the threshold passes, at the amplitude actually measured", () => {
  // Across six launches the largest across-launch delta at 1x was 36/255.
  // Model it as frame-wide at 36 and it must be silent under rule 1 — and
  // under rule 2 as well, since a scattered 36 is exactly the BlurView
  // backdrop and not a defect... except that rule 2 counts anything over
  // 8/255, so a FRAME-WIDE version of it would trip. Measured reality is
  // 0.6% of the frame, so model that share.
  const delta = blank();
  const noisy = Math.floor(WIDTH * HEIGHT * 0.006);
  for (let i = 0; i < noisy; i += 1) delta[i * 37 % (WIDTH * HEIGHT)] = 36;
  const report = judge(blockDensities(delta, opts), RULES);
  assert.equal(report.aboveThreshold, 0, "nothing over 48/255");
  assert.equal(report.pass, true);
});

test("a broad faint shift FAILS even though no pixel crosses the threshold", () => {
  // A colour token moving a few levels across the whole screen: invisible to
  // rule 1 by construction, and the reason rule 2 exists.
  const delta = blank();
  delta.fill(20);
  const report = judge(blockDensities(delta, opts), RULES);
  assert.equal(report.aboveThreshold, 0);
  assert.equal(report.pass, false);
  assert.match(report.reasons.join(" "), /frame shifted faintly/);
});

test("a granted budget still cannot hide a compact defect — the block rule catches it", () => {
  // The tolerance path: a route with a generous pixel budget. The #257 defect
  // shape fills more than 30% of its block, so rule 3 fires even though the
  // pixel count is under budget.
  const delta = blank();
  for (let y = 0; y < DEFECT_SHAPE.height; y += 1) {
    for (let x = 0; x < DEFECT_SHAPE.width; x += 1) delta[y * WIDTH + x] = 200;
  }
  const generous = { ...RULES, maxPixels: 100_000, broadFramePct: 100 };
  const report = judge(blockDensities(delta, opts), generous);
  assert.equal(report.pass, false);
  assert.equal(report.failing.length >= 1, true);
  assert.match(report.reasons.join(" "), /block\(s\) over 30% density/);
});
