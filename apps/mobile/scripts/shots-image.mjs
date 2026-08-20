/**
 * shots-image.mjs — the two image operations the golden pipeline depends on.
 *
 * Both live here rather than inline in the comparator because the golden
 * WRITER and the golden READER must perform byte-identical work. A downsample
 * that differs by a filter setting between the two would produce a diff on
 * every route forever, and the obvious "fix" for that is to loosen the
 * threshold — which is how a suite stops finding bugs.
 *
 * Requires ImageMagick 7 (`magick`). It is not optional here: without it there
 * is no comparison at all, so its absence is a hard error rather than the
 * skip-and-carry-on that shots.mjs's fingerprint uses.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

export async function requireMagick() {
  try {
    await execFileAsync("magick", ["-version"], { maxBuffer: 4 * 1024 * 1024 });
  } catch {
    throw new Error(
      "ImageMagick (`magick`) is required to compare screenshots. " +
        "Install it: brew install imagemagick",
    );
  }
}

export async function identify(file) {
  const { stdout } = await execFileAsync("magick", ["identify", "-format", "%w %h", file], {
    maxBuffer: 1024 * 1024,
  });
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`could not read dimensions of ${file} (magick said "${stdout.trim()}")`);
  }
  return { width, height };
}

/**
 * Downsample by an exact integer factor, box-averaging each NxN source block
 * into one destination pixel.
 *
 * `-filter Box` at an exact 1/N scale is a plain arithmetic mean over the
 * source block — no interpolation kernel, no phase, nothing that depends on
 * the source's sub-pixel content beyond its average. That is the whole reason
 * goldens are stored downsampled: the residual noise this harness cannot
 * eliminate (a per-launch re-sample of GlassPanel's BlurView backdrop,
 * measured at ~1 LSB over ~1.95M pixels) is averaged 9-to-1 at 3x -> 1x, while
 * a displaced or clipped glyph — a large delta over a compact region — is not.
 * The measured effect is in the Stage C summary; do not change the filter
 * without re-measuring it.
 *
 * `-alpha off` matters: simulator PNGs carry an opaque alpha channel, and
 * leaving it on makes `-separate` yield four channels instead of three, so the
 * later `-evaluate-sequence max` would fold a constant 255 into every pixel.
 */
export async function downsample(src, dst, factor) {
  const { width, height } = await identify(src);
  if (width % factor !== 0 || height % factor !== 0) {
    throw new Error(
      `${src} is ${width}x${height}, which is not divisible by ${factor}. ` +
        "The golden scale must divide the capture exactly, or the average is " +
        "taken over ragged blocks and the two sides stop being comparable.",
    );
  }
  await execFileAsync(
    "magick",
    [
      src,
      "-alpha", "off",
      "-filter", "Box",
      "-resize", `${width / factor}x${height / factor}!`,
      "-depth", "8",
      `PNG24:${dst}`,
    ],
    { maxBuffer: MAX_BUFFER },
  );
  return { width: width / factor, height: height / factor };
}

/**
 * The per-pixel, max-over-channels absolute difference of two images, returned
 * as one byte per pixel.
 *
 * Deliberately raw bytes rather than a histogram or a magick-side `-resize`
 * down to a block grid. The block rule needs exact per-block counts, and
 * ImageMagick's resize semantics (colorspace, gamma, filter support) are a
 * subtle dependency to hang a pass/fail decision on. Counting in JS is exact,
 * auditable, unit-testable against synthetic buffers, and — on a 440x956
 * golden — costs under a millisecond.
 */
export async function maxChannelDelta(a, b) {
  const { stdout } = await execFileAsync(
    "magick",
    [
      a, b,
      "-alpha", "off",
      "-compose", "difference", "-composite",
      "-separate", "-evaluate-sequence", "max",
      "-depth", "8",
      "gray:-",
    ],
    { maxBuffer: MAX_BUFFER, encoding: "buffer" },
  );
  return stdout;
}
