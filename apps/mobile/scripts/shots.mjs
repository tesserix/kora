#!/usr/bin/env node
/**
 * shots.mjs — unattended screenshot capture from an iOS simulator.
 *
 * This is the CAPTURE half of kora#257. It deliberately contains NO
 * assertions and produces NO pass/fail result: it walks a declared route
 * list, screenshots each screen, and writes a manifest. What (if anything)
 * to assert on top of these images is a separate decision that needs the
 * noise data this script exists to produce — see
 * .planning/quick/20260819-screenshot-harness/NOISE-REPORT.md.
 *
 * Usage:
 *   node scripts/shots.mjs --content-size medium --out .shots/medium
 *   node scripts/shots.mjs --content-size accessibility-extra-large --out .shots/axl
 *
 * Options:
 *   --content-size <size>  iOS dynamic-type size (default: medium).
 *   --out <dir>            Output directory (default: .shots/<content-size>).
 *   --udid <udid>          Target simulator (default: $KORA_SHOTS_UDID, else
 *                          the single booted device).
 *   --port <n>             Metro port to point the dev client at (default 8081).
 *                          Pass --no-launch to attach to whatever is running.
 *   --repeat <n>           Capture every route n times (default 1). Used to
 *                          measure the noise floor.
 *   --relaunch-each-repeat Relaunch the app between repeats instead of
 *                          re-capturing within one launch. The two modes have
 *                          different noise characteristics; measure both.
 *   --settle <ms>          Wait after navigating before the shutter
 *                          (default 2500). Routes may override, see
 *                          shots.routes.mjs.
 *   --boot-wait <ms>       Wait after launching the app (default 35000).
 *                          The dev client has to fetch and evaluate a bundle.
 *   --routes <a,b,c>       Only capture these route names.
 *   --scheme <scheme>      URL scheme for deep links (default: com.tesserix.kora).
 *   --no-launch            Do not terminate/relaunch the app at all.
 *   --allow-any-device     Bypass the iPhone 17 Pro Max requirement. Read the
 *                          note next to DEVICE_REQUIREMENT before you use it.
 *
 * PRECONDITION — AUTHENTICATION. Most routes need a signed-in app. This script
 * does NOT script sign-up: doing so is slow and unreliable (idb's text entry
 * truncates, iOS's "Use Strong Password?" sheet swallows the typed password,
 * and tap coordinates move as the keyboard opens). Sign in ONCE by hand on the
 * target simulator; the credential survives relaunches, so every run after
 * that is repeatable. Routes that land on the sign-in wall are still captured,
 * and flagged `landedOnSignIn: true` in the manifest rather than failing the
 * run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routes as ALL_ROUTES } from "./shots.routes.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

const BUNDLE_ID = "com.tesserix.kora";

/**
 * Capture on the iPhone 17 Pro Max, or do not capture.
 *
 * The narrower iPhone 17 Pro hides exactly the class of bug this harness
 * exists to catch: text that fits on a 402pt-wide screen and clips on the
 * 440pt one, or vice versa. A previous session drew a wrong conclusion from
 * the Pro. If you genuinely need another device, pass --allow-any-device and
 * say in the PR why the result is still meaningful.
 */
const DEVICE_REQUIREMENT = "iPhone 17 Pro Max";

const DEFAULTS = {
  contentSize: "medium",
  settle: 2500,
  bootWait: 35_000,
  repeat: 1,
  port: 8081,
  scheme: BUNDLE_ID,
};

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ...DEFAULTS,
    out: null,
    udid: process.env.KORA_SHOTS_UDID ?? null,
    routes: null,
    launch: true,
    relaunchEachRepeat: false,
    allowAnyDevice: false,
  };

  const takeValue = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    return value;
  };

  const int = (raw, flag) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative integer, got "${raw}"`);
    return n;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--content-size": opts.contentSize = takeValue(i, flag); i += 1; break;
      case "--out": opts.out = takeValue(i, flag); i += 1; break;
      case "--udid": opts.udid = takeValue(i, flag); i += 1; break;
      case "--scheme": opts.scheme = takeValue(i, flag); i += 1; break;
      case "--port": opts.port = int(takeValue(i, flag), flag); i += 1; break;
      case "--repeat": opts.repeat = Math.max(1, int(takeValue(i, flag), flag)); i += 1; break;
      case "--settle": opts.settle = int(takeValue(i, flag), flag); i += 1; break;
      case "--boot-wait": opts.bootWait = int(takeValue(i, flag), flag); i += 1; break;
      case "--routes": opts.routes = takeValue(i, flag).split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--relaunch-each-repeat": opts.relaunchEachRepeat = true; break;
      case "--no-launch": opts.launch = false; break;
      case "--allow-any-device": opts.allowAnyDevice = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }

  opts.out = opts.out ?? path.join(".shots", opts.contentSize);
  return opts;
}

// ---------------------------------------------------------------------------
// simctl
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simctl(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("xcrun", ["simctl", ...args], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (allowFailure) return "";
    throw new Error(`xcrun simctl ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

/** Every booted simulator, as {udid, name, runtime}. */
async function bootedDevices() {
  const raw = await simctl(["list", "devices", "booted", "--json"]);
  const parsed = JSON.parse(raw);
  return Object.entries(parsed.devices).flatMap(([runtime, devices]) =>
    devices.filter((d) => d.state === "Booted").map((d) => ({ udid: d.udid, name: d.name, runtime })),
  );
}

async function resolveDevice({ udid, allowAnyDevice }) {
  const booted = await bootedDevices();
  if (booted.length === 0) {
    throw new Error("no booted simulator. Boot one: xcrun simctl boot '<device name>'");
  }

  let device;
  if (udid) {
    device = booted.find((d) => d.udid === udid);
    if (!device) {
      throw new Error(
        `simulator ${udid} is not booted. Booted: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}`,
      );
    }
  } else if (booted.length === 1) {
    device = booted[0];
  } else {
    throw new Error(
      `${booted.length} simulators booted; pass --udid. Booted: ` +
        booted.map((d) => `${d.name} (${d.udid})`).join(", "),
    );
  }

  if (device.name !== DEVICE_REQUIREMENT && !allowAnyDevice) {
    throw new Error(
      `refusing to capture on "${device.name}". This harness requires ${DEVICE_REQUIREMENT}: ` +
        `the narrower iPhone 17 Pro conceals the layout bugs these shots exist to catch, ` +
        `and that mistake has already produced a wrong conclusion in this repo. ` +
        `Override with --allow-any-device only if you can say why the result is still meaningful.`,
    );
  }
  return device;
}

/**
 * A content-size change does not reflow a running app: UIKit reads the
 * preferred category at launch and React Native's Text scaling is resolved
 * from it. Set it, THEN relaunch — never the other way round.
 */
async function setContentSize(udid, size) {
  await simctl(["ui", udid, "content_size", size]);
  const current = (await simctl(["ui", udid, "content_size"])).trim();
  if (current !== size) {
    throw new Error(`content size did not stick: asked for "${size}", simulator reports "${current}"`);
  }
  return current;
}

/**
 * Terminate and relaunch through the dev client. Launching by URL rather than
 * `simctl launch` is what points the dev client at a specific Metro; a plain
 * launch reuses whatever bundle URL it last had.
 */
async function launchApp(udid, port) {
  await simctl(["terminate", udid, BUNDLE_ID], { allowFailure: true });
  await sleep(1500);
  const metro = encodeURIComponent(`http://localhost:${port}`);
  await simctl(["openurl", udid, `${BUNDLE_ID}://expo-development-client/?url=${metro}`]);
}

async function navigate(udid, scheme, routePath) {
  const suffix = routePath.startsWith("/") ? routePath.slice(1) : routePath;
  await simctl(["openurl", udid, `${scheme}://${suffix}`]);
}

async function screenshot(udid, file) {
  await simctl(["io", udid, "screenshot", file]);
}

// ---------------------------------------------------------------------------
// sign-in-wall detection
// ---------------------------------------------------------------------------

/**
 * A coarse 16x16 grayscale fingerprint, used only to notice that a route
 * bounced to the sign-in wall. Deliberately far too lossy to be an assertion —
 * it answers "is this the same screen?", not "is this screen correct?".
 *
 * ImageMagick is optional. Without it the manifest records
 * `landedOnSignIn: null` and the run is otherwise unaffected.
 */
async function fingerprint(file) {
  try {
    const { stdout } = await execFileAsync(
      "magick",
      [file, "-resize", "16x16!", "-colorspace", "gray", "-depth", "8", "txt:-"],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .slice(1)
      .map((line) => line.match(/gray\((\d+)/)?.[1])
      .filter(Boolean)
      .map(Number);
  } catch {
    return null;
  }
}

/** Mean absolute difference of two fingerprints, 0-255. */
function fingerprintDistance(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return null;
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

// Empirical: repeat captures of one screen sit under 1; two different screens
// in this app are comfortably above 4.
const SAME_SCREEN_DISTANCE = 2.5;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

function selectRoutes(names) {
  if (!names) return ALL_ROUTES;
  const byName = new Map(ALL_ROUTES.map((r) => [r.name, r]));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown route(s): ${unknown.join(", ")}. Known: ${ALL_ROUTES.map((r) => r.name).join(", ")}`,
    );
  }
  return names.map((n) => byName.get(n));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  const device = await resolveDevice(opts);
  const selected = selectRoutes(opts.routes);
  const outDir = path.resolve(APP_ROOT, opts.out);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  console.log(`device      ${device.name} (${device.udid}) ${device.runtime}`);
  console.log(`contentSize ${opts.contentSize}`);
  console.log(`out         ${outDir}`);
  console.log(`routes      ${selected.length} x ${opts.repeat}`);
  console.log(
    `mode        ${opts.relaunchEachRepeat ? "relaunch between repeats" : "repeats within one launch"}`,
  );

  const contentSize = await setContentSize(device.udid, opts.contentSize);

  const startedAt = new Date().toISOString();
  const shots = [];
  let signInPrint = null;

  const relaunch = async () => {
    if (!opts.launch) return;
    await launchApp(device.udid, opts.port);
    await sleep(opts.bootWait);
  };

  // Repeats are the OUTER loop when relaunching, so that one launch produces
  // one complete pass over every route. Making them the inner loop would mean
  // a relaunch per route per repeat, which measures something else entirely
  // (and takes n_routes times as long).
  await relaunch();

  for (let pass = 1; pass <= opts.repeat; pass += 1) {
    if (pass > 1 && opts.relaunchEachRepeat) await relaunch();

    for (const route of selected) {
      const suffix = opts.repeat > 1 ? `.${String(pass).padStart(2, "0")}` : "";
      const file = path.join(outDir, `${route.name}${suffix}.png`);
      const settle = route.settle ?? opts.settle;

      await navigate(device.udid, opts.scheme, route.path);
      await sleep(settle);
      await screenshot(device.udid, file);

      const print = await fingerprint(file);
      if (route.name === "sign-in" && signInPrint === null) signInPrint = print;
      const distance = fingerprintDistance(print, signInPrint);
      const landedOnSignIn =
        route.name === "sign-in" || distance === null ? null : distance < SAME_SCREEN_DISTANCE;

      shots.push({
        route: route.name,
        path: route.path,
        auth: route.auth,
        pass,
        file: path.relative(outDir, file),
        contentSize,
        settleMs: settle,
        capturedAt: new Date().toISOString(),
        landedOnSignIn,
        note: route.note ?? null,
      });

      console.log(
        `  ${String(pass).padStart(2)} ${route.name.padEnd(14)} ${route.path.padEnd(14)}` +
          (landedOnSignIn ? " [sign-in wall]" : ""),
      );
    }
  }

  const manifest = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    device: { name: device.name, udid: device.udid, runtime: device.runtime },
    contentSize,
    scheme: opts.scheme,
    metroPort: opts.launch ? opts.port : null,
    repeat: opts.repeat,
    relaunchEachRepeat: opts.relaunchEachRepeat,
    // A run where these are all true was captured signed out; the
    // auth-required images are pictures of the sign-in wall, not of the app.
    signedOut: shots.some((s) => s.landedOnSignIn === true),
    shots,
  };

  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${shots.length} shots + manifest.json to ${outDir}`);
  if (manifest.signedOut) {
    console.log(
      "NOTE: some routes landed on the sign-in wall. Sign in on the simulator by hand and re-run.",
    );
  }
}

const HELP = `shots.mjs — capture app screenshots from a booted iOS simulator.

  node scripts/shots.mjs --content-size medium --out .shots/medium
  node scripts/shots.mjs --content-size accessibility-extra-large --out .shots/axl

Sign in on the simulator BY HAND once before running; the harness does not
script sign-up. See the header comment in this file for every flag.
`;

main().catch((err) => {
  console.error(`shots: ${err.message}`);
  process.exitCode = 1;
});
