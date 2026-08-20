#!/usr/bin/env node
/**
 * shots-golden.mjs — capture, or promote, the committed golden set.
 *
 * Deliberately a separate command from both capture and comparison, because
 * accepting a new golden is a DECISION. It rewrites the only record of what
 * the app is supposed to look like, and if it were a flag on the comparator
 * ("--update") the path of least resistance for a red run would be to take it.
 *
 *   npm run shots:golden                      capture fresh, then promote
 *   npm run shots:golden -- --from .shots/x   promote an existing capture
 *   npm run shots:golden -- --routes tab-today  update a subset
 *
 * The captured PNGs are downsampled 3x -> 1x on the way in (see
 * scripts/shots.goldens.mjs for why) and written to
 * shots-golden/<content-size>/<route>.png, with a manifest recording exactly
 * how they were produced.
 *
 * ---------------------------------------------------------------------------
 * What it refuses to write
 * ---------------------------------------------------------------------------
 *   - a route that never became ready (a picture of a loading or error state)
 *   - a route with renderErrors — an "Unimplemented component" LogBox sitting
 *     on top of real UI. A golden with one of those in it does not just fail
 *     to catch the bug, it makes the bug the expected result.
 *   - anything at all, if the capture ran without EXPO_PUBLIC_SHOTS_CLOCK or
 *     landed on the sign-in wall
 *   - a route listed in EXCLUDED for that content size
 *
 * Each refusal is loud and exits non-zero. There is no --force.
 */

import { readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireMagick, downsample } from "./shots-image.mjs";
import { EXCLUDED, GOLDEN, exclusionFor } from "./shots.goldens.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const opts = {
    from: null,
    contentSize: GOLDEN.contentSizes[0],
    routes: null,
    port: 8081,
    udid: process.env.KORA_SHOTS_UDID ?? null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--from": opts.from = value(); i += 1; break;
      case "--content-size": opts.contentSize = value(); i += 1; break;
      case "--routes": opts.routes = value(); i += 1; break;
      case "--port": opts.port = Number.parseInt(value(), 10); i += 1; break;
      case "--udid": opts.udid = value(); i += 1; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return opts;
}

/** Run shots.mjs ourselves so a golden can never be captured with odd flags. */
async function capture(opts) {
  const out = path.join(".shots", `golden-capture-${opts.contentSize}`);
  const args = [
    path.join(HERE, "shots.mjs"),
    "--content-size", opts.contentSize,
    "--out", out,
    "--port", String(opts.port),
    // A render error is fatal here even though it is only a warning during
    // ordinary capture: this is the one moment where the image becomes the
    // definition of correct.
    "--strict-render",
  ];
  if (opts.routes) args.push("--routes", opts.routes);
  if (opts.udid) args.push("--udid", opts.udid);

  console.log(`capturing: node ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
  const child = execFileAsync("node", args, { cwd: APP_ROOT, maxBuffer: 32 * 1024 * 1024 });
  child.child.stdout?.pipe(process.stdout);
  child.child.stderr?.pipe(process.stderr);
  await child;
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  await requireMagick();

  if (!opts.from && !process.env.EXPO_PUBLIC_SHOTS_CLOCK) {
    throw new Error(
      "EXPO_PUBLIC_SHOTS_CLOCK is not set in this shell. Goldens must be captured with the " +
        "app clock pinned, and Metro must have been started with the SAME pin (it inlines the " +
        "value into the bundle). See scripts/shots.mjs's header.",
    );
  }

  const fromDir = opts.from ?? (await capture(opts));
  const captureDir = path.resolve(APP_ROOT, fromDir);
  const manifest = JSON.parse(await readFile(path.join(captureDir, "manifest.json"), "utf8"));
  const contentSize = manifest.contentSize;

  const blockers = [];
  if (!manifest.shotsClock) blockers.push("the capture ran without EXPO_PUBLIC_SHOTS_CLOCK");
  if (manifest.signedOut) blockers.push("the capture landed on the sign-in wall");
  if (manifest.repeat !== 1) blockers.push(`the capture has repeat=${manifest.repeat}; promote a single pass`);
  if (blockers.length > 0) {
    console.error("REFUSING to write goldens:");
    for (const b of blockers) console.error(`  - ${b}`);
    process.exitCode = 1;
    return;
  }

  const goldenSet = path.join(APP_ROOT, GOLDEN.dir, contentSize);
  await mkdir(goldenSet, { recursive: true });

  const written = [];
  const skipped = [];
  const refused = [];

  for (const shot of manifest.shots) {
    const excluded = exclusionFor(contentSize, shot.route);
    if (excluded) {
      skipped.push({ route: shot.route, reason: `excluded: ${excluded}` });
      continue;
    }
    if (shot.ready === false) {
      refused.push({ route: shot.route, reason: `never became ready — ${shot.readyReason}` });
      continue;
    }
    if (shot.renderErrors?.length > 0) {
      refused.push({
        route: shot.route,
        reason: `render error(s) ${JSON.stringify(shot.renderErrors)} — a LogBox is covering real UI`,
      });
      continue;
    }
    if (shot.landedOnSignIn === true) {
      refused.push({ route: shot.route, reason: "landed on the sign-in wall" });
      continue;
    }

    const src = path.join(captureDir, shot.file);
    const dst = path.join(goldenSet, `${shot.route}.png`);
    const dims = await downsample(src, dst, GOLDEN.scale);
    const { size } = await stat(dst);
    written.push({ route: shot.route, ...dims, bytes: size });
  }

  if (refused.length > 0) {
    console.error(`\nREFUSING to write ${refused.length} golden(s):`);
    for (const r of refused) console.error(`  ${r.route.padEnd(14)} ${r.reason}`);
    console.error(
      "\nNothing was written for those routes; any previous golden is untouched. Fix the " +
        "capture — do not promote a picture of a loading state or a LogBox overlay.",
    );
    process.exitCode = 1;
    return;
  }

  // Only prune when this was a full run; a --routes subset legitimately leaves
  // the other goldens in place.
  const partial = Boolean(opts.routes) || manifest.shots.length < 5;
  if (!partial) {
    const stale = (await readdir(goldenSet))
      .filter((f) => f.endsWith(".png"))
      .map((f) => f.replace(/\.png$/, ""))
      .filter((route) => !written.some((w) => w.route === route));
    for (const route of stale) {
      await rm(path.join(goldenSet, `${route}.png`));
      skipped.push({ route, reason: "deleted: no longer captured, or newly excluded" });
    }
  }

  const goldenManifest = {
    schemaVersion: 1,
    contentSize,
    // Provenance. A golden is only meaningful against the same device, runtime
    // and clock, and the comparator enforces each of these. The udid is
    // deliberately dropped: it identifies one person's simulator, not the
    // device model the pixels depend on.
    device: { name: manifest.device?.name ?? null, runtime: manifest.device?.runtime ?? null },
    shotsClock: manifest.shotsClock,
    statusBarTime: manifest.statusBarTime,
    scheme: manifest.scheme,
    capturedAt: manifest.finishedAt,
    gitCommit: await gitCommit(),
    rule: {
      scale: GOLDEN.scale,
      threshold: GOLDEN.threshold,
      maxPixels: GOLDEN.maxPixels,
      broadThreshold: GOLDEN.broadThreshold,
      broadFramePct: GOLDEN.broadFramePct,
      block: GOLDEN.block,
      failDensity: GOLDEN.failDensity,
    },
    routes: written.sort((a, b) => a.route.localeCompare(b.route)),
    excluded: Object.entries(EXCLUDED[contentSize] ?? {}).map(([route, reason]) => ({ route, reason })),
  };
  await writeFile(
    path.join(goldenSet, "manifest.json"),
    `${JSON.stringify(goldenManifest, null, 2)}\n`,
    "utf8",
  );

  const totalBytes = written.reduce((sum, w) => sum + w.bytes, 0);
  console.log(`\nwrote ${written.length} golden(s) to ${path.relative(APP_ROOT, goldenSet)}`);
  for (const w of written) {
    console.log(`  ${w.route.padEnd(14)} ${w.width}x${w.height}  ${(w.bytes / 1024).toFixed(0)} KB`);
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (skipped.length > 0) {
    console.log(`\n${skipped.length} route(s) not written:`);
    for (const s of skipped) console.log(`  ${s.route.padEnd(14)} ${s.reason}`);
  }
}

async function gitCommit() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: APP_ROOT });
    return stdout.trim();
  } catch {
    return null;
  }
}

const HELP = `shots-golden.mjs — capture or promote the committed golden set.

  npm run shots:golden                        capture fresh, then promote
  npm run shots:golden -- --from .shots/x     promote an existing capture
  npm run shots:golden -- --routes tab-today  update one route

  --from <dir>          promote an existing shots.mjs output instead of capturing
  --content-size <s>    content size to capture (default: ${GOLDEN.contentSizes[0]})
  --routes <a,b>        subset; other goldens are left alone
  --port <n>            Metro port for the capture (default 8081)
  --udid <udid>         target simulator (default: $KORA_SHOTS_UDID)

Goldens are stored at 1/${GOLDEN.scale} scale. Excluded routes and the reasons
for their exclusion live in scripts/shots.goldens.mjs.
`;

main().catch((err) => {
  console.error(`shots-golden: ${err.message}`);
  process.exitCode = 1;
});
