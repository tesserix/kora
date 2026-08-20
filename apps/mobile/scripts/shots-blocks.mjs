/**
 * shots-blocks.mjs — the comparison RULE, as pure functions over a delta map.
 *
 * ---------------------------------------------------------------------------
 * Three rules, because one geometry is not enough (kora#257, Stages A-C)
 * ---------------------------------------------------------------------------
 * A difference between two screenshots has a shape, and the shape decides
 * which rule can see it. Measured on this app:
 *
 *   COMPACT AND STRONG — a row of content displaced by a 2pt padding change:
 *   17,027 pixels over 48/255, filling 49% of its densest block.
 *
 *   TINY AND STRONG — one character deleted from a card title: 38 pixels over
 *   48/255, filling 9.0% of its block. Text is thin; a small label edit does
 *   not come close to filling a block. THIS is why a block-density rule cannot
 *   be the only rule: at any density above the noise floor it sails past the
 *   exact bug class #257 was opened for.
 *
 *   BROAD AND WEAK — a colour token moving a few levels across a card: little
 *   or nothing over 48/255, but a large share of the frame over 8/255.
 *
 *   SCATTERED AND WEAK (the noise) — GlassPanel's BlurView backdrop
 *   re-sampling per launch. Frame-wide, and at the 1x scale goldens are stored
 *   at it never exceeds 36/255 anywhere.
 *
 * So: a strict pixel budget above a threshold set over the noise ceiling
 * catches the first two; a frame-share budget at a much lower threshold
 * catches the third; and the block-density rule from #272's plan is kept as
 * the tolerance mechanism for any route granted a non-zero pixel budget. The
 * numbers, and the measurements behind each, are in shots.goldens.mjs.
 *
 * These functions take the delta map produced by shots-image.maxChannelDelta
 * and know nothing about ImageMagick, files or routes, so the rule can be
 * exercised against synthetic buffers. See __tests__/shots-blocks.test.mjs.
 *
 * ---------------------------------------------------------------------------
 * The masked band (kora#289 follow-up)
 * ---------------------------------------------------------------------------
 * `ignoreTop` removes the top N rows — the iOS status bar and Dynamic Island —
 * from all three rules and from the frame-share denominator. That strip is
 * drawn by the system, not by the app, and #289 shipped a golden set that
 * failed all 13 routes on 243 pixels of it. The full reasoning, the
 * measurements and the experiments that ruled out simply pinning it harder are
 * in shots.goldens.mjs next to the constant.
 */

/**
 * Split `length` into blocks of `block`, with a final short block if it does
 * not divide evenly. The short block is measured over its REAL pixel count
 * rather than padded to full size: padding with "no difference" would dilute
 * the density of a defect sitting in the last strip of the screen, which on a
 * 440x956 golden is the tab bar.
 */
function spans(length, block) {
  const out = [];
  for (let start = 0; start < length; start += block) {
    out.push({ start, end: Math.min(start + block, length) });
  }
  return out;
}

/**
 * Per-block density of pixels whose max-channel delta exceeds `threshold`.
 *
 * Returns every block that has any differing pixel at all, sorted densest
 * first, plus the global counts for reporting.
 */
export function blockDensities(
  delta,
  { width, height, block, threshold, broadThreshold = 8, ignoreTop = 0 },
) {
  if (delta.length !== width * height) {
    throw new Error(`delta map is ${delta.length} bytes, expected ${width * height} (${width}x${height})`);
  }
  if (ignoreTop < 0 || ignoreTop >= height) {
    throw new Error(`ignoreTop must be within [0, ${height}); got ${ignoreTop}`);
  }

  // Masked rows are skipped by every rule AND removed from the frame-share
  // denominator. Leaving them in the denominator would make the broad rule
  // quietly cheaper every time the mask grew, which is the kind of loosening
  // that does not show up in a diff.
  const measuredPixels = width * (height - ignoreTop);

  const blocks = [];
  let aboveThreshold = 0;
  let aboveBroad = 0;
  let differing = 0;
  let maxDelta = 0;

  for (const rows of spans(height, block)) {
    // A block straddling the mask boundary is measured over the part of it
    // that is below the mask, at its real area — same reasoning as the short
    // edge blocks above.
    const top = Math.max(rows.start, ignoreTop);
    if (top >= rows.end) continue;
    for (const cols of spans(width, block)) {
      let count = 0;
      for (let y = top; y < rows.end; y += 1) {
        const rowOffset = y * width;
        for (let x = cols.start; x < cols.end; x += 1) {
          const value = delta[rowOffset + x];
          if (value === 0) continue;
          differing += 1;
          if (value > maxDelta) maxDelta = value;
          if (value > broadThreshold) aboveBroad += 1;
          if (value > threshold) count += 1;
        }
      }
      if (count === 0) continue;
      aboveThreshold += count;
      const area = (rows.end - top) * (cols.end - cols.start);
      blocks.push({
        x: cols.start,
        y: top,
        width: cols.end - cols.start,
        height: rows.end - top,
        pixels: count,
        area,
        density: count / area,
      });
    }
  }

  blocks.sort((a, b) => b.density - a.density || b.pixels - a.pixels);

  return {
    width,
    height,
    ignoreTop,
    totalPixels: measuredPixels,
    maxDelta,
    differing,
    aboveThreshold,
    aboveBroad,
    diffPct: (aboveThreshold / measuredPixels) * 100,
    broadPct: (aboveBroad / measuredPixels) * 100,
    blocks,
    worstBlock: blocks[0] ?? null,
  };
}

/**
 * Apply the rules to a blockDensities() result.
 *
 * Returns every reason it failed rather than the first, because "it also moved
 * 40% of the frame" is information you want in the same run as "and this block
 * is 60% dense", not on the next one.
 */
export function judge(report, { maxPixels = 0, failDensity, broadFramePct }) {
  const failing = report.blocks.filter((b) => b.density > failDensity);
  const reasons = [];
  if (report.aboveThreshold > maxPixels) {
    reasons.push(
      maxPixels === 0
        ? `${report.aboveThreshold} pixel(s) differ beyond the threshold`
        : `${report.aboveThreshold} pixel(s) differ, budget ${maxPixels}`,
    );
  }
  if (failing.length > 0) {
    reasons.push(`${failing.length} block(s) over ${(failDensity * 100).toFixed(0)}% density`);
  }
  if (broadFramePct !== undefined && report.broadPct > broadFramePct) {
    reasons.push(
      `${report.broadPct.toFixed(3)}% of the frame shifted faintly, budget ${broadFramePct}%`,
    );
  }
  return { ...report, failing, reasons, pass: reasons.length === 0 };
}

/** "x,y 20x20" — where to look on the golden, in golden-space pixels. */
export function describeBlock(b) {
  return `${b.x},${b.y} ${b.width}x${b.height}`;
}
