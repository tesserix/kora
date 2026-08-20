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
 *   --settle <ms>          EXTRA dwell after a route reports ready, for
 *                          animation only (default 3000). This is no longer
 *                          what decides when to shoot — see the readiness
 *                          gate below. Routes may override.
 *   --ready-timeout <ms>   How long to wait for a route to become ready
 *                          before failing it (default 25000).
 *   --poll-interval <ms>   Accessibility-tree poll period (default 750).
 *   --no-ready-gate        Shoot on the timer alone, as this harness did
 *                          before kora#257 Stage B. Produces images you
 *                          cannot trust; for debugging the gate itself.
 *   --strict-render        Also fail the run when a capture contains a
 *                          RENDER_ERRORS marker (a stale dev client's
 *                          "Unimplemented component" LogBox, typically).
 *   --idb <path>           idb binary (default: $KORA_IDB, else `idb` on
 *                          PATH, else ~/Library/Python/3.9/bin/idb).
 *   --boot-wait <ms>       Wait after launching the app (default 35000).
 *                          The dev client has to fetch and evaluate a bundle.
 *   --routes <a,b,c>       Only capture these route names.
 *   --scheme <scheme>      URL scheme for deep links (default: com.tesserix.kora).
 *   --no-launch            Do not terminate/relaunch the app at all.
 *   --allow-any-device     Bypass the iPhone 17 Pro Max requirement. Read the
 *                          note next to DEVICE_REQUIREMENT before you use it.
 *
 * PRECONDITION — A PINNED CLOCK. Home renders a greeting and a date from the
 * device clock, so an unpinned run cannot be byte-stable across a lunch break.
 * Start Metro with the pin set, because EXPO_PUBLIC_* values are inlined into
 * the bundle by Metro, not read by this script:
 *
 *   EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
 *   EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
 *   npx expo start --dev-client --port 8083
 *
 * The value is echoed into the manifest as `shotsClock` from THIS process's
 * environment, so export it here too and the two agree. See
 * src/lib/shotsClock.ts for why it can never be live in a release build.
 *
 * THE READINESS GATE (kora#257 Stage B). The shutter does not fire on a timer.
 * After navigating, the harness polls `idb ui describe-all` until the route's
 * declared `ready` text is on screen and no "Loading…"/"Retry"/"Couldn't"
 * marker is, then shoots. A route that never becomes ready is captured to
 * `<name>.not-ready.png`, marked `ready: false` in the manifest, and FAILS the
 * run with a non-zero exit.
 *
 * That last part is the point. #272 found that every large across-launch
 * difference was a picture of a different screen — a fixed timer expiring
 * mid-fetch — and no pixel tolerance can absorb a 250/255 delta over half the
 * frame. A capture that fails honestly is worth far more than one that
 * silently records the wrong screen. See shots.routes.mjs for the selectors.
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
import { routes as ALL_ROUTES, NOT_READY, RENDER_ERRORS } from "./shots.routes.mjs";

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
  // Extra dwell AFTER the readiness gate opens, never a substitute for it.
  //
  // The gate answers "is the content there?", which on an animated screen is
  // true a long time before the pixels stop moving. Measured: with the gate
  // open and settle at 250ms, `tab-today` differed across launches by 1.005%
  // of the frame — WORSE than the 0.801% #272 recorded with its old 4000ms
  // timer. At 3000ms it drops to 0.113%. The gate had done its job; the
  // shutter was simply firing mid-animation.
  //
  // 3000 comes from the longest one-shot entrance in the app:
  // SpecularSweep is withDelay(500, withTiming(..., 1600)) = 2100ms from
  // mount (src/components/instrument/SpecularSweep.tsx), plus margin. Every
  // entrance here is one-shot, so a dwell genuinely ends the motion — there
  // is no looping animation to chase.
  //
  // Global rather than per-route on purpose: a new animated screen should be
  // stable by default rather than noisy until someone notices.
  settle: 3000,
  readyTimeout: 25_000,
  pollInterval: 750,
  bootWait: 35_000,
  repeat: 1,
  port: 8081,
  scheme: BUNDLE_ID,
};

/**
 * The status-bar clock is the one piece of on-screen time simctl CAN pin, and
 * an un-pinned one changes every minute in the top-left of all 14 frames.
 * 9:41 is Apple's own convention. The app's own clock is a separate problem
 * with a separate fix — see src/lib/shotsClock.ts.
 */
const STATUS_BAR_TIME = "9:41";

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
    readyGate: true,
    strictRender: false,
    idb: process.env.KORA_IDB ?? null,
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
      case "--ready-timeout": opts.readyTimeout = int(takeValue(i, flag), flag); i += 1; break;
      case "--poll-interval": opts.pollInterval = Math.max(50, int(takeValue(i, flag), flag)); i += 1; break;
      case "--idb": opts.idb = takeValue(i, flag); i += 1; break;
      case "--no-ready-gate": opts.readyGate = false; break;
      case "--strict-render": opts.strictRender = true; break;
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
 * Pin the status bar.
 *
 * NO LONGER LOAD-BEARING, and the reason is worth knowing before anyone
 * decides to trust it again. kora#289's goldens were captured with this pin in
 * place; the clock, wifi and cellular components took and the battery LEVEL
 * took, but `--batteryState charged` did not — every golden carried the
 * discharging glyph, and all 13 routes failed on the same 243 pixels. `simctl`
 * exited 0 and `simctl status_bar list` reported the requested value; the
 * recorded override and the rendered pixels had simply diverged, and nothing
 * reads the pixels back. The trigger did not reproduce across twenty monitored
 * probes, a content-size change, terminate/relaunch, a SpringBoard restart or
 * a full harness run.
 *
 * So the comparison masks the whole band instead (GOLDEN.ignoreTop in
 * shots.goldens.mjs), and this call is kept only because a pinned bar makes
 * the captured images comparable to a human eye. Do NOT re-derive an assertion
 * from it.
 */
async function pinStatusBar(udid) {
  await simctl([
    "status_bar", udid, "override",
    "--time", STATUS_BAR_TIME,
    "--dataNetwork", "wifi",
    "--wifiMode", "active",
    "--wifiBars", "3",
    "--cellularMode", "active",
    "--cellularBars", "4",
    "--batteryState", "charged",
    "--batteryLevel", "100",
  ]);
}

/**
 * Terminate and relaunch through the dev client. Launching by URL rather than
 * `simctl launch` is what points the dev client at a specific Metro; a plain
 * launch reuses whatever bundle URL it last had.
 */
/**
 * Turn off expo-dev-menu's floating action button.
 *
 * The draggable gear sits in a window ABOVE app content — it overlaps the
 * notification bell on tab-today and the settings affordance on every stack
 * screen — and its position lives in UserDefaults, so it moves between
 * sessions and machines. #272 correctly refused to mask it: a fixed mask would
 * also hide the real UI underneath, and a moving one cannot be derived from
 * the image at all.
 *
 * It does not need a rebuild or a release build either. expo-dev-menu reads
 * `EXDevMenuShowFloatingActionButton` straight out of UserDefaults
 * (node_modules/expo-dev-menu/ios/Modules/DevMenuPreferences.swift), so
 * writing it false on the simulator is enough. Verified: the `gearshape.fill`
 * node disappears from the accessibility tree entirely.
 *
 * Must run while the app is NOT running — iOS flushes an app's defaults on
 * termination and would clobber the write. Hence its position here, after
 * terminate and before the launch URL.
 *
 * SIDE EFFECT worth knowing: this is a persistent per-simulator preference, so
 * after any run the gear stays gone for interactive development too. The dev
 * menu itself is unaffected (shake, or Cmd+D). To get the button back:
 *
 *   xcrun simctl spawn <udid> defaults write com.tesserix.kora \
 *     EXDevMenuShowFloatingActionButton -bool YES
 */
async function disableDevMenuFab(udid) {
  await simctl(
    ["spawn", udid, "defaults", "write", BUNDLE_ID, "EXDevMenuShowFloatingActionButton", "-bool", "NO"],
    { allowFailure: true },
  );
}

async function launchApp(udid, port) {
  await simctl(["terminate", udid, BUNDLE_ID], { allowFailure: true });
  await sleep(1500);
  await disableDevMenuFab(udid);
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
// readiness gate — the accessibility tree decides when to shoot
// ---------------------------------------------------------------------------

/**
 * idb ships as a Python console script and is routinely NOT on PATH (Homebrew
 * puts it in ~/Library/Python/<v>/bin). Resolve it once and say so clearly if
 * it is missing, rather than failing 14 times with ENOENT.
 */
async function resolveIdb(explicit) {
  const candidates = [
    explicit,
    "idb",
    path.join(process.env.HOME ?? "", "Library/Python/3.9/bin/idb"),
    "/opt/homebrew/bin/idb",
    "/usr/local/bin/idb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--help"], { maxBuffer: 4 * 1024 * 1024 });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    "idb not found, and the readiness gate needs it to read the accessibility " +
      "tree. Install it (pip3 install fb-idb) and pass --idb <path> or set " +
      "KORA_IDB, or run with --no-ready-gate to fall back to timer-only " +
      "capture — but then do not trust the images.",
  );
}

/**
 * The whole accessibility tree as a flat list of visible strings.
 *
 * idb's companion process goes stale and the FIRST describe-all after an app
 * launch frequently comes back as a JSON decode error or empty output. It
 * recovers on its own; retrying is the documented workaround and is cheaper
 * than restarting the companion. Do not remove this loop — without it roughly
 * one route per launch fails for a reason that has nothing to do with the app.
 */
async function describeAll(idbBin, udid, { attempts = 4 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(idbBin, ["ui", "describe-all", "--udid", udid], {
        maxBuffer: 64 * 1024 * 1024,
      });
      const parsed = JSON.parse(stdout);
      if (!Array.isArray(parsed)) throw new Error("describe-all did not return an array");
      return parsed;
    } catch (err) {
      lastError = err;
      await sleep(700 * attempt);
    }
  }
  throw new Error(
    `idb ui describe-all failed ${attempts}x: ${lastError?.stderr || lastError?.message}`,
  );
}

/** Every AXLabel/AXValue/title on screen, as one lowercase-preserving list. */
function visibleText(tree) {
  const out = [];
  for (const node of tree) {
    for (const key of ["AXLabel", "AXValue", "title", "help"]) {
      const value = node?.[key];
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return out;
}

const hasText = (texts, needle) => texts.some((t) => t.includes(needle));

/**
 * Evaluate one route's readiness against a snapshot of the tree.
 * Returns {ready, missing, blocked, renderErrors}.
 */
function evaluateReady(route, texts) {
  const required = route.ready ?? [];
  const anyOf = route.readyAny ?? null;
  const allowed = new Set(route.allow ?? []);

  const missing = required.filter((needle) => !hasText(texts, needle));
  if (anyOf && anyOf.length > 0 && !anyOf.some((needle) => hasText(texts, needle))) {
    missing.push(`any of [${anyOf.join(" | ")}]`);
  }
  const blocked = NOT_READY.filter((needle) => !allowed.has(needle) && hasText(texts, needle));
  const renderErrors = RENDER_ERRORS.filter((needle) => hasText(texts, needle));

  return { ready: missing.length === 0 && blocked.length === 0, missing, blocked, renderErrors };
}

/**
 * Poll until the route is ready, or give up. Giving up is a first-class
 * outcome: it returns {ready:false} with the reason, and the caller records the
 * capture as untrustworthy and fails the run. It never shoots hopefully.
 */
async function waitForReady(idbBin, udid, route, { timeout, pollInterval }) {
  if (!route.ready || route.ready.length === 0) {
    return { ready: null, reason: "route declares no `ready` selector", polls: 0, waitedMs: 0, renderErrors: [] };
  }

  // `simctl openurl` returns as soon as the URL is handed to the app, before
  // the router has swapped screens. Without this grace the first poll can read
  // the OUTGOING route's tree — harmless while every route's selectors are
  // distinct, but a silent way to shoot the wrong screen the day two routes
  // share a section header.
  const NAV_GRACE_MS = 500;
  await sleep(NAV_GRACE_MS);

  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let polls = 0;
  let last = { missing: route.ready, blocked: [], renderErrors: [] };

  for (;;) {
    polls += 1;
    const texts = visibleText(await describeAll(idbBin, udid));
    last = evaluateReady(route, texts);
    if (last.ready) {
      return { ready: true, reason: null, polls, waitedMs: Date.now() - startedAt, renderErrors: last.renderErrors };
    }
    if (Date.now() >= deadline) {
      const parts = [];
      if (last.missing.length > 0) parts.push(`missing ${JSON.stringify(last.missing)}`);
      if (last.blocked.length > 0) parts.push(`blocked by ${JSON.stringify(last.blocked)}`);
      return {
        ready: false,
        reason: `not ready after ${timeout}ms — ${parts.join("; ") || "unknown"}`,
        polls,
        waitedMs: Date.now() - startedAt,
        renderErrors: last.renderErrors,
      };
    }
    await sleep(pollInterval);
  }
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
  let stdout;
  try {
    stdout = (
      await execFileAsync(
        "magick",
        // `-alpha off` matters: these PNGs carry an alpha channel, and with it
        // ImageMagick labels each pixel `graya(29,1)` rather than `gray(29)`.
        // The original parse looked for `gray(` and therefore matched NOTHING,
        // silently — see the comment on the empty-result guard below.
        [file, "-alpha", "off", "-resize", "16x16!", "-colorspace", "gray", "-depth", "8", "txt:-"],
        { maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout;
  } catch {
    // ImageMagick genuinely absent or failed. Documented as optional: the
    // manifest records `landedOnSignIn: null` and the run is unaffected.
    return null;
  }

  const values = stdout
    .split("\n")
    .slice(1)
    // `graya?` tolerates both spellings, so the alpha flag above is belt and
    // braces rather than the only thing holding this together.
    .map((line) => line.match(/graya?\((\d+)/)?.[1])
    .filter(Boolean)
    .map(Number);

  // THE POINT OF THIS GUARD (kora#257): magick ran, produced output, and the
  // parse matched nothing. Returning [] here would flow into
  // fingerprintDistance, which returns null for an empty array, which reads in
  // the manifest as "ImageMagick not installed" — indistinguishable from the
  // honest case. The sign-in-wall detector was inert for 28 captures across two
  // full runs exactly this way, reporting `landedOnSignIn: null` throughout.
  //
  // A safety check that always answers "fine" is worse than no check, and this
  // whole harness exists because a green suite gave false confidence. So a
  // parse failure is LOUD.
  if (values.length === 0) {
    throw new Error(
      `fingerprint: magick produced output for ${file} but no pixels parsed. ` +
        "The txt: format likely changed — check the pixel-enumeration line spelling.",
    );
  }
  return values;
}

/**
 * Detect the dev client's blue "Refreshing…" banner over the status bar.
 *
 * FOUND THE HARD WAY (kora#257 Stage C): one capture in 45 had it, and it cost
 * `profile` 8.5% of the frame with a 100%-density block — an instant, and
 * entirely spurious, comparator failure. It is not app state, so the readiness
 * gate cannot see it: like iOS's "Use Strong Password?" sheet it renders in
 * another window, and `idb ui describe-all` returns the app's tree only. Its
 * text also collides with real copy — coach says "Refreshing today's focus…" —
 * so a text marker would be both unreliable and ambiguous.
 *
 * The image, though, is unambiguous. The banner paints a saturated system blue
 * across the full width behind the status bar, where this app is always very
 * dark. Mean the band and ask whether blue dominates.
 *
 * Reported per-shot rather than retried, for the same reason the not-ready
 * images are still written: a capture you can look at beats a silent retry
 * loop. Goldens refuse it (shots-golden.mjs) and comparisons refuse it
 * (shots-compare.mjs).
 */
async function detectSystemBanner(file) {
  try {
    const { stdout } = await execFileAsync(
      "magick",
      [file, "-alpha", "off", "-crop", "1320x40+0+96", "+repage", "-resize", "1x1!",
       "-format", "%[fx:mean.r] %[fx:mean.g] %[fx:mean.b]", "info:"],
      { maxBuffer: 1024 * 1024 },
    );
    const [r, g, b] = stdout.trim().split(/\s+/).map(Number);
    if (![r, g, b].every(Number.isFinite)) return null;
    // Measured: normal status bar band ~(0.05,0.03,0.01); with the banner
    // ~(0.10,0.35,0.62). Requiring blue to be both bright and dominant keeps
    // this from firing on a dark blue-tinted screen.
    return b > 0.3 && b > r * 2 && b > g * 1.4;
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

  const idbBin = opts.readyGate ? await resolveIdb(opts.idb) : null;
  console.log(`readyGate   ${opts.readyGate ? `${idbBin} (timeout ${opts.readyTimeout}ms)` : "OFF — images are untrustworthy"}`);
  console.log(
    `clock       ${process.env.EXPO_PUBLIC_SHOTS_CLOCK ?? "NOT PINNED — greeting and date will drift between runs"}`,
  );

  const contentSize = await setContentSize(device.udid, opts.contentSize);
  await pinStatusBar(device.udid);

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
      const settle = route.settle ?? opts.settle;

      await navigate(device.udid, opts.scheme, route.path);

      const gate = opts.readyGate
        ? await waitForReady(idbBin, device.udid, route, {
            timeout: opts.readyTimeout,
            pollInterval: opts.pollInterval,
          })
        : { ready: null, reason: "readiness gate disabled", polls: 0, waitedMs: 0, renderErrors: [] };

      // Extra dwell for entrance animation, once the content itself is there.
      await sleep(settle);

      // A capture that did not pass the gate is still written — you cannot
      // diagnose a timeout from a manifest line alone — but under a name no
      // golden comparison will ever pick up, and it fails the run below.
      const stem = gate.ready === false ? `${route.name}${suffix}.not-ready` : `${route.name}${suffix}`;
      const file = path.join(outDir, `${stem}.png`);
      await screenshot(device.udid, file);

      const systemBanner = await detectSystemBanner(file);
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
        systemBanner,
        ready: gate.ready,
        readyReason: gate.reason,
        readyWaitedMs: gate.waitedMs,
        readyPolls: gate.polls,
        renderErrors: gate.renderErrors,
        note: route.note ?? null,
      });

      const status =
        gate.ready === true
          ? `ready in ${String(gate.waitedMs).padStart(5)}ms`
          : gate.ready === false
            ? "NOT READY"
            : "no gate";
      console.log(
        `  ${String(pass).padStart(2)} ${route.name.padEnd(14)} ${route.path.padEnd(10)} ${status}` +
          (gate.renderErrors.length > 0 ? " [render-error]" : "") +
          (systemBanner ? " [system banner]" : "") +
          (landedOnSignIn ? " [sign-in wall]" : ""),
      );
      if (gate.ready === false) console.log(`     ${gate.reason}`);
    }
  }

  const notReady = shots.filter((s) => s.ready === false);
  const withRenderErrors = shots.filter((s) => s.renderErrors.length > 0);
  const withSystemBanner = shots.filter((s) => s.systemBanner === true);

  const manifest = {
    schemaVersion: 2,
    startedAt,
    finishedAt: new Date().toISOString(),
    device: { name: device.name, udid: device.udid, runtime: device.runtime },
    contentSize,
    scheme: opts.scheme,
    metroPort: opts.launch ? opts.port : null,
    repeat: opts.repeat,
    relaunchEachRepeat: opts.relaunchEachRepeat,
    readyGate: opts.readyGate,
    readyTimeoutMs: opts.readyTimeout,
    statusBarTime: STATUS_BAR_TIME,
    // Read from THIS process's environment. It is Metro that inlines the value
    // into the bundle, so this is an assertion about how the run was invoked,
    // not a readback from the app. Null here means date-bearing screens are
    // not byte-stable across days.
    shotsClock: process.env.EXPO_PUBLIC_SHOTS_CLOCK ?? null,
    // Consumers (Stage C) must refuse to diff a run where this is non-empty:
    // those files are pictures of a loading or error state, not of the screen.
    notReady: notReady.map((s) => ({ route: s.route, pass: s.pass, reason: s.readyReason })),
    // Present but not fatal by default — a build defect, not app state.
    renderErrors: withRenderErrors.map((s) => ({ route: s.route, pass: s.pass, markers: s.renderErrors })),
    // The dev client's blue "Refreshing…" banner, painted over the status bar
    // by another process. Never promotable to a golden, never comparable.
    systemBanner: withSystemBanner.map((s) => ({ route: s.route, pass: s.pass })),
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

  if (withSystemBanner.length > 0) {
    const routes = [...new Set(withSystemBanner.map((s) => s.route))];
    console.log(
      `\nSYSTEM BANNER in ${withSystemBanner.length} capture(s) across ${routes.length} route(s): ` +
        `${routes.join(", ")}.\nThe dev client painted its blue "Refreshing…" bar over the status ` +
        "bar. Those frames are not comparable and cannot become goldens — re-run them.",
    );
  }

  if (withRenderErrors.length > 0) {
    const routes = [...new Set(withRenderErrors.map((s) => s.route))];
    console.log(
      `\nRENDER ERRORS in ${withRenderErrors.length} capture(s) across ${routes.length} route(s): ` +
        `${routes.join(", ")}.\nThese images contain a LogBox overlay sitting on top of real UI — ` +
        `a build defect, not app state. Rebuild the dev client (npx expo run:ios --device ` +
        `"${DEVICE_REQUIREMENT}") before committing any golden.`,
    );
  }

  // Fail loudly. The alternative — exiting 0 with a manifest nobody reads — is
  // exactly how #272 ended up with a 0.000%-diff run in which all three passes
  // showed "Couldn't load your profile".
  if (notReady.length > 0) {
    console.error(`\n${notReady.length} capture(s) NEVER BECAME READY:`);
    for (const s of notReady) console.error(`  ${s.route} pass ${s.pass}: ${s.readyReason}`);
    console.error(
      "These are pictures of a loading or error state. Do not diff them, and do not " +
        "raise --ready-timeout to make them go away without first looking at the .not-ready.png.",
    );
    process.exitCode = 1;
  } else if (opts.strictRender && withRenderErrors.length > 0) {
    console.error("\n--strict-render: failing because captures contain render errors.");
    process.exitCode = 1;
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
