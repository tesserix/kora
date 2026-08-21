#!/usr/bin/env node
/**
 * shots-compare.mjs — assert a fresh capture against the committed goldens.
 *
 * This is the ASSERTION half of kora#257. `shots.mjs` captures and judges
 * nothing; this script judges and captures nothing.
 *
 *   npm run shots:compare -- --candidate .shots/medium
 *   npm run shots:compare -- --candidate .shots/medium --json
 *
 * Capture first, with the clock pinned and Metro started with the same pin:
 *
 *   EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 npm run shots -- \
 *     --content-size medium --out .shots/medium --port 8083
 *
 * ---------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------------
 *   1. No pixel may differ from the golden by more than 48/255, at the 1x
 *      scale goldens are stored at. Zero budget, because across six launches
 *      fourteen of fifteen routes differ by exactly zero pixels at that
 *      threshold, and a rule that fires on one pixel catches a one-character
 *      label change — which no density budget does.
 *   2. No more than 3% of the frame may differ by more than 8/255, which
 *      catches a broad, faint shift that rule 1 is deliberately blind to.
 *   3. No block may exceed 30% density — the tolerance mechanism for any route
 *      granted a pixel budget under rule 1. No route has one today.
 *
 * All three are applied BELOW the masked band: the top 62 rows are the iOS
 * status bar and Dynamic Island, which the system draws and the harness cannot
 * reliably pin — kora#289 shipped a golden set that failed every route on 243
 * pixels of it. See GOLDEN.ignoreTop in scripts/shots.goldens.mjs.
 *
 * The reasoning, and the measurements each number came from, are in
 * scripts/shots-blocks.mjs and scripts/shots.goldens.mjs. Nothing about the
 * rules is configurable from the command line on purpose: a threshold that can
 * be raised by a flag will be.
 *
 * ---------------------------------------------------------------------------
 * What this refuses to do
 * ---------------------------------------------------------------------------
 * It will not compare a capture it does not trust, and it exits non-zero for
 * each of these rather than reporting a hollow pass:
 *
 *   - a candidate whose manifest lists any route as not-ready (a picture of a
 *     loading or error state)
 *   - a candidate with renderErrors (a LogBox overlay sitting on real UI)
 *   - a candidate captured without EXPO_PUBLIC_SHOTS_CLOCK, on a different
 *     device, or at a different content size than the golden set
 *   - a golden that has no candidate, or a candidate route with a golden that
 *     is a different size
 *
 * A route with no golden and no exclusion is also an error. Silently skipping
 * a route is precisely how a suite ends up asserting on three screens and
 * reporting success.
 */

import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireMagick, identify, downsample, maxChannelDelta } from "./shots-image.mjs";
import { blockDensities, judge, describeBlock } from "./shots-blocks.mjs";
import { GOLDEN, budgetFor, exclusionFor } from "./shots.goldens.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const opts = { candidate: null, goldenDir: GOLDEN.dir, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--candidate": opts.candidate = value(); i += 1; break;
      case "--golden": opts.goldenDir = value(); i += 1; break;
      case "--json": opts.json = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!opts.help && !opts.candidate) throw new Error("--candidate <dir> is required");
  return opts;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Everything that has to be true about a capture before its pixels mean
 * anything. Returns a list of reasons it does not; empty means usable.
 */
function auditCandidate(manifest, goldenManifest) {
  const problems = [];
  if (manifest.notReady?.length > 0) {
    const routes = manifest.notReady.map((n) => `${n.route}(pass ${n.pass})`).join(", ");
    problems.push(`capture contains not-ready routes: ${routes}`);
  }
  if (manifest.systemBanner?.length > 0) {
    const routes = manifest.systemBanner.map((r) => r.route).join(", ");
    problems.push(
      `capture has the dev client's blue "Refreshing…" banner over ${routes} — ` +
        "another process painted over the status bar",
    );
  }
  if (manifest.renderErrors?.length > 0) {
    const routes = [...new Set(manifest.renderErrors.map((r) => r.route))].join(", ");
    problems.push(
      `capture contains render errors on ${routes} — a LogBox overlay is sitting on real UI`,
    );
  }
  if (manifest.signedOut) {
    problems.push("capture landed on the sign-in wall; the auth-required routes are not the app");
  }
  if (!manifest.shotsClock) {
    problems.push(
      "capture ran without EXPO_PUBLIC_SHOTS_CLOCK, so date and greeting text is whatever today is",
    );
  } else if (goldenManifest.shotsClock && manifest.shotsClock !== goldenManifest.shotsClock) {
    problems.push(
      `clock pin differs: golden ${goldenManifest.shotsClock}, candidate ${manifest.shotsClock}`,
    );
  }
  if (manifest.contentSize !== goldenManifest.contentSize) {
    problems.push(
      `content size differs: golden ${goldenManifest.contentSize}, candidate ${manifest.contentSize}`,
    );
  }
  if (
    goldenManifest.rule &&
    goldenManifest.rule.ignoreTop !== undefined &&
    goldenManifest.rule.ignoreTop !== GOLDEN.ignoreTop
  ) {
    problems.push(
      `ignored band differs: goldens were accepted with the top ` +
        `${goldenManifest.rule.ignoreTop}px masked, this comparator masks ` +
        `${GOLDEN.ignoreTop}px. Re-accept the goldens or restore the constant.`,
    );
  }
  if (goldenManifest.device?.name && manifest.device?.name !== goldenManifest.device.name) {
    problems.push(
      `device differs: golden ${goldenManifest.device.name}, candidate ${manifest.device?.name}`,
    );
  }
  return problems;
}

async function compareRoute(goldenFile, candidateFile, workDir, maxPixels) {
  const golden = await identify(goldenFile);
  const normalised = path.join(workDir, `${path.basename(candidateFile)}`);
  await downsample(candidateFile, normalised, GOLDEN.scale);
  const candidate = await identify(normalised);

  if (candidate.width !== golden.width || candidate.height !== golden.height) {
    return {
      error:
        `size mismatch: golden ${golden.width}x${golden.height}, ` +
        `candidate ${candidate.width}x${candidate.height} after 1/${GOLDEN.scale} downsample`,
    };
  }

  const delta = await maxChannelDelta(goldenFile, normalised);
  const report = blockDensities(delta, {
    width: golden.width,
    height: golden.height,
    block: GOLDEN.block,
    threshold: GOLDEN.threshold,
    broadThreshold: GOLDEN.broadThreshold,
    ignoreTop: GOLDEN.ignoreTop,
  });
  return judge(report, {
    maxPixels,
    failDensity: GOLDEN.failDensity,
    broadFramePct: GOLDEN.broadFramePct,
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  await requireMagick();

  const candidateDir = path.resolve(APP_ROOT, opts.candidate);
  const candidateManifest = await readJson(path.join(candidateDir, "manifest.json"));
  const contentSize = candidateManifest.contentSize;

  const goldenSet = path.resolve(APP_ROOT, opts.goldenDir, contentSize);
  let goldenManifest;
  try {
    goldenManifest = await readJson(path.join(goldenSet, "manifest.json"));
  } catch {
    throw new Error(
      `no goldens for content size "${contentSize}" at ${goldenSet}. ` +
        `Capture them deliberately: npm run shots:golden -- --content-size ${contentSize}`,
    );
  }

  const problems = auditCandidate(candidateManifest, goldenManifest);
  if (problems.length > 0) {
    console.error("REFUSING TO COMPARE — the candidate capture is not trustworthy:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nThese are not tolerances to widen. Fix the capture and re-run; a comparison " +
        "against a picture of a loading state proves nothing either way.",
    );
    process.exitCode = 1;
    return;
  }

  const goldenFiles = (await readdir(goldenSet)).filter((f) => f.endsWith(".png"));
  const goldenRoutes = new Set(goldenFiles.map((f) => f.replace(/\.png$/, "")));
  const capturedRoutes = new Set(
    candidateManifest.shots.filter((s) => s.ready !== false).map((s) => s.route),
  );

  const excluded = [];
  const missingGolden = [];
  for (const route of capturedRoutes) {
    if (goldenRoutes.has(route)) continue;
    const reason = exclusionFor(contentSize, route);
    if (reason) excluded.push({ route, reason });
    else missingGolden.push(route);
  }
  const missingCandidate = [...goldenRoutes].filter((r) => !capturedRoutes.has(r));

  console.log(`golden      ${path.relative(APP_ROOT, goldenSet)} (${goldenRoutes.size} routes)`);
  console.log(`candidate   ${path.relative(APP_ROOT, candidateDir)} (${capturedRoutes.size} routes)`);
  console.log(
    `rules       1/${GOLDEN.scale} scale · <=${GOLDEN.maxPixels}px over ${GOLDEN.threshold}/255 · ` +
      `<=${GOLDEN.broadFramePct}% of frame over ${GOLDEN.broadThreshold}/255 · ` +
      `no ${GOLDEN.block}px block over ${(GOLDEN.failDensity * 100).toFixed(0)}% dense`,
  );
  console.log(`clock       ${goldenManifest.shotsClock}`);
  // Printed every run for the same reason the exclusions are: a region that is
  // not being asserted on should never be something you have to read the
  // source to discover.
  console.log(
    `ignored     top ${GOLDEN.ignoreTop}px of every frame — iOS status bar and ` +
      "Dynamic Island, drawn by the system (see scripts/shots.goldens.mjs)",
  );

  // Exclusions are printed on EVERY run, with their reasons, so that the
  // shrinking of the suite is visible rather than archaeological.
  if (excluded.length > 0) {
    console.log(`\n${excluded.length} route(s) deliberately NOT asserted:`);
    for (const e of excluded) console.log(`  ${e.route.padEnd(14)} ${e.reason}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "shots-compare-"));
  const results = [];
  try {
    console.log("");
    console.log("route           maxΔ  over48    faint%   worst block          density  verdict");
    for (const route of [...goldenRoutes].sort()) {
      if (!capturedRoutes.has(route)) continue;
      const shot = candidateManifest.shots.find((s) => s.route === route);
      const result = await compareRoute(
        path.join(goldenSet, `${route}.png`),
        path.join(candidateDir, shot.file),
        workDir,
        budgetFor(contentSize, route),
      );
      if (result.error) {
        results.push({ route, pass: false, error: result.error });
        console.log(`${route.padEnd(15)} ${result.error}`);
        continue;
      }
      const worst = result.worstBlock;
      results.push({
        route,
        pass: result.pass,
        maxDelta: result.maxDelta,
        aboveThreshold: result.aboveThreshold,
        broadPct: result.broadPct,
        worstBlock: worst,
        failing: result.failing,
        reasons: result.reasons,
      });
      console.log(
        [
          route.padEnd(15),
          String(result.maxDelta).padStart(4),
          String(result.aboveThreshold).padStart(8),
          result.broadPct.toFixed(3).padStart(8),
          (worst ? describeBlock(worst) : "-").padEnd(20),
          (worst ? `${(worst.density * 100).toFixed(1)}%` : "-").padStart(8),
          result.pass ? "  ok" : "  FAIL",
        ].join(" "),
      );
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ contentSize, rule: GOLDEN, excluded, missingGolden, missingCandidate, results }, null, 2)}\n`,
    );
  }

  if (missingGolden.length > 0) {
    console.error(
      `\n${missingGolden.length} captured route(s) have NEITHER a golden NOR an exclusion: ` +
        `${missingGolden.join(", ")}.\nAdd a golden (npm run shots:golden) or record why the ` +
        "route cannot have one in scripts/shots.goldens.mjs. Skipping it quietly is not an option.",
    );
    process.exitCode = 1;
  }
  if (missingCandidate.length > 0) {
    console.error(
      `\n${missingCandidate.length} golden(s) have no candidate capture: ${missingCandidate.join(", ")}. ` +
        "Either the route was dropped from shots.routes.mjs — in which case delete its golden — " +
        "or this run was narrowed with --routes and cannot be a full comparison.",
    );
    process.exitCode = 1;
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} route(s) FAILED:`);
    for (const r of failed) {
      if (r.error) {
        console.error(`  ${r.route}: ${r.error}`);
        continue;
      }
      console.error(`  ${r.route}: ${r.reasons.join("; ")}`);
      for (const b of r.failing.slice(0, 5)) {
        console.error(
          `    block ${describeBlock(b)} — ${(b.density * 100).toFixed(1)}% ` +
            `(${b.pixels}/${b.area} px) at ${GOLDEN.scale}x: ` +
            `${b.x * GOLDEN.scale},${b.y * GOLDEN.scale} ` +
            `${b.width * GOLDEN.scale}x${b.height * GOLDEN.scale}`,
        );
      }
      if (r.failing.length > 5) console.error(`    ... and ${r.failing.length - 5} more`);
    }
    console.error(
      "\nLook at the images before touching the threshold. If the change is intended, " +
        "re-capture the goldens: npm run shots:golden",
    );
    process.exitCode = 1;
  } else if (process.exitCode !== 1) {
    console.log(`\nAll ${results.length} compared route(s) within tolerance.`);
  }
}

const HELP = `shots-compare.mjs — compare a capture against the committed goldens.

  node scripts/shots-compare.mjs --candidate .shots/medium
  node scripts/shots-compare.mjs --candidate .shots/medium --json

  --candidate <dir>  a directory written by scripts/shots.mjs (required)
  --golden <dir>     golden root (default: ${GOLDEN.dir})
  --json             also emit the full result as JSON

The rule and its thresholds are not command-line options. See
scripts/shots.goldens.mjs.
`;

main().catch((err) => {
  console.error(`shots-compare: ${err.message}`);
  process.exitCode = 1;
});
