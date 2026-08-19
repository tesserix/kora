#!/usr/bin/env node
/**
 * shots-noise.mjs — measure the noise floor of the screenshot harness.
 *
 * Answers the question that has to be settled before kora#257 asserts
 * anything: how much do two captures of THE SAME screen with IDENTICAL code
 * differ? Anything an assertion flags below that floor is a false positive,
 * and a suite that cries wolf gets muted and then hides the next real bug.
 *
 * Feed it a directory produced by `shots.mjs --repeat N`. For every route it
 * compares every pair of passes and reports the worst pair:
 *
 *   maxDelta      largest per-channel difference, 0-255
 *   above{N}      pixels whose max-channel delta exceeds N
 *   diffPct       share of the frame above the 8/255 threshold
 *   blocksTouched share of a 22x48 grid containing any differing pixel.
 *                 Low  => spatially concentrated => a real difference.
 *                 High => scattered => antialias/compositing noise.
 *   topBlockShare share of all differing pixels in the single densest block.
 *                 High => one localised region moved.
 *
 * Usage:
 *   node scripts/shots-noise.mjs .shots/medium-inlaunch [...more dirs]
 *   node scripts/shots-noise.mjs --json .shots/medium-inlaunch
 *
 * Requires ImageMagick (`magick`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const THRESHOLDS = [0, 2, 4, 8, 16, 32, 64];
// The threshold the summary columns key off. 8/255 is above 1-LSB rounding
// but well below anything a human would call a visible difference.
const VISIBLE = 8;
const GRID_COLS = 22;
const GRID_ROWS = 48;

/**
 * Per-pixel max-channel absolute difference, as an 8-bit grayscale image,
 * summarised as a histogram of level -> pixel count. One magick invocation,
 * no per-pixel work in JS.
 */
async function diffHistogram(a, b) {
  const { stdout } = await execFileAsync(
    "magick",
    [a, b, "-compose", "difference", "-composite", "-separate", "-evaluate-sequence", "max",
     "-depth", "8", "-format", "%c", "histogram:info:-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const histogram = new Map();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+):.*gray\((\d+)/);
    if (m) histogram.set(Number(m[2]), (histogram.get(Number(m[2])) ?? 0) + Number(m[1]));
  }
  return histogram;
}

/**
 * Where the differing pixels are. Thresholds the difference to binary, then
 * box-averages down to a coarse grid: each cell's mean is the fraction of
 * that cell above threshold.
 */
async function diffGrid(a, b, threshold) {
  const { stdout } = await execFileAsync(
    "magick",
    [a, b, "-compose", "difference", "-composite", "-separate", "-evaluate-sequence", "max",
     "-threshold", `${(threshold / 255) * 100}%`,
     "-filter", "Box", "-resize", `${GRID_COLS}x${GRID_ROWS}!`,
     "-depth", "16", "txt:-"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const cells = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/gray\(([\d.]+)%?\)/);
    if (m) cells.push(Number(m[1]) / (line.includes("%") ? 100 : 65535));
  }
  return cells;
}

function summariseHistogram(histogram) {
  let total = 0;
  let maxDelta = 0;
  for (const [level, count] of histogram) {
    total += count;
    if (level > maxDelta && count > 0) maxDelta = level;
  }
  const above = {};
  for (const t of THRESHOLDS) {
    let n = 0;
    for (const [level, count] of histogram) if (level > t) n += count;
    above[t] = n;
  }
  return { totalPixels: total, maxDelta, above };
}

function summariseGrid(cells) {
  const nonEmpty = cells.filter((c) => c > 0);
  const sum = cells.reduce((a, c) => a + c, 0);
  return {
    blocksTouched: cells.length === 0 ? 0 : nonEmpty.length / cells.length,
    topBlockShare: sum === 0 ? 0 : Math.max(0, ...cells) / sum,
  };
}

/** Group `route.NN.png` files by route name. */
function groupPasses(files) {
  const groups = new Map();
  for (const file of files) {
    const m = file.match(/^(.+)\.(\d+)\.png$/);
    if (!m) continue;
    const [, route] = m;
    if (!groups.has(route)) groups.set(route, []);
    groups.get(route).push(file);
  }
  for (const list of groups.values()) list.sort();
  return groups;
}

async function analyseDir(dir) {
  const files = await readdir(dir);
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch { /* manifest is nice to have, not required */ }

  const groups = groupPasses(files);
  const routes = [];

  for (const [route, passes] of [...groups].sort()) {
    if (passes.length < 2) continue;
    let worst = null;

    for (let i = 0; i < passes.length; i += 1) {
      for (let j = i + 1; j < passes.length; j += 1) {
        const a = path.join(dir, passes[i]);
        const b = path.join(dir, passes[j]);
        const stats = summariseHistogram(await diffHistogram(a, b));
        const pair = { pair: `${i + 1}v${j + 1}`, ...stats };
        if (!worst || pair.above[VISIBLE] > worst.above[VISIBLE] || pair.maxDelta > worst.maxDelta) {
          worst = pair;
        }
      }
    }

    // Only locate the difference when there is one to locate.
    let spatial = { blocksTouched: 0, topBlockShare: 0 };
    if (worst.above[VISIBLE] > 0) {
      const [i, j] = worst.pair.split("v").map(Number);
      const cells = await diffGrid(path.join(dir, passes[i - 1]), path.join(dir, passes[j - 1]), VISIBLE);
      spatial = summariseGrid(cells);
    }

    routes.push({
      route,
      passes: passes.length,
      worstPair: worst.pair,
      totalPixels: worst.totalPixels,
      maxDelta: worst.maxDelta,
      above: worst.above,
      diffPct: (worst.above[VISIBLE] / worst.totalPixels) * 100,
      ...spatial,
      identical: worst.above[0] === 0,
    });
  }

  return {
    dir,
    contentSize: manifest?.contentSize ?? null,
    relaunchEachRepeat: manifest?.relaunchEachRepeat ?? null,
    device: manifest?.device?.name ?? null,
    routes,
  };
}

function renderTable(result) {
  const mode = result.relaunchEachRepeat === null
    ? "unknown"
    : result.relaunchEachRepeat ? "across launches" : "within one launch";
  const lines = [];
  lines.push("");
  lines.push(`${result.dir}  [${result.contentSize ?? "?"}, ${mode}]`);
  lines.push(
    "route           pair  maxΔ  >0        >4        >8        >16       >32       diff%   blocks%  top%",
  );
  for (const r of result.routes) {
    lines.push(
      [
        r.route.padEnd(15),
        r.worstPair.padEnd(5),
        String(r.maxDelta).padStart(4),
        String(r.above[0]).padStart(9),
        String(r.above[4]).padStart(9),
        String(r.above[8]).padStart(9),
        String(r.above[16]).padStart(9),
        String(r.above[32]).padStart(9),
        r.diffPct.toFixed(3).padStart(7),
        (r.blocksTouched * 100).toFixed(1).padStart(8),
        (r.topBlockShare * 100).toFixed(1).padStart(5),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dirs = args.filter((a) => !a.startsWith("--"));
  if (dirs.length === 0) {
    console.error("usage: node scripts/shots-noise.mjs [--json] <shots-dir> [...]");
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const dir of dirs) results.push(await analyseDir(dir));

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  for (const result of results) console.log(renderTable(result));
}

main().catch((err) => {
  console.error(`shots-noise: ${err.message}`);
  process.exitCode = 1;
});
