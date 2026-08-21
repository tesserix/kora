// A pinnable clock, for the screenshot harness only (kora#257 Stage B).
//
// WHY THIS EXISTS
// Home renders "Good morning" / "Good afternoon" / "Good evening" from
// `new Date().getHours()`, and a date like "Wed, Aug 19" beside it. Diary
// renders a week strip built from today. A golden image captured this morning
// therefore fails this afternoon, and every date-bearing screen fails
// tomorrow — before a single line of app code has changed.
//
// That matters more than it sounds for the diffing stage this unblocks. The
// rule under consideration fails a frame when any 60x60 block has >40% of its
// pixels differing. A changed greeting or date string is exactly that:
// spatially concentrated, high-contrast text. Left alone it would trip the
// rule on every run, which is how a suite gets muted.
//
// `xcrun simctl` can pin the STATUS BAR clock (shots.mjs does) but has no way
// to pin the clock the app itself reads. So the pin has to live here.
//
// WHY NOT MASK THOSE REGIONS INSTEAD
// Masking loses coverage precisely where text is most likely to overflow —
// header rows with a long date and a long greeting side by side are among the
// likeliest places for the clipping bug that motivated this work. A mask would
// blind the suite to the bug it exists to catch.
//
// HOW IT IS GUARANTEED INERT IN PRODUCTION — three independent barriers:
//
//  1. `__DEV__` is `false` in any release bundle, so `readPin()` returns null
//     before it ever looks at the environment.
//  2. Metro's release minifier constant-folds `__DEV__` to `false` and drops
//     the branch entirely, so the shipped bundle contains no pin logic at all.
//  3. `EXPO_PUBLIC_SHOTS_CLOCK` is set in no eas.json build profile
//     (development, preview or production). EXPO_PUBLIC_* values are inlined
//     at bundle time, so a variable absent from the build environment is
//     inlined as `undefined` and cannot be introduced later at runtime.
//
// Any one of the three is sufficient; all three hold.
//
// SCOPE — READS, NOT WRITES
// This pins what the UI DISPLAYS and what it QUERIES. It deliberately does not
// touch the timestamps attached to writes (`logged_at`, the offline queue's
// `queuedAt`, `localDateNow()` in request bodies). Those must stay real: a
// dev with the pin set would otherwise file logs under a fabricated day, and
// the offline queue's replay ordering depends on a monotonic real clock.

/** Format accepted by EXPO_PUBLIC_SHOTS_CLOCK, for the error message. */
const EXAMPLE = "2026-08-19T09:41:00";

function readPin(): number | null {
  // Barrier 1 and 2. Keep this as the first statement so the minifier can drop
  // everything below it.
  if (!__DEV__) return null;

  const raw = process.env.EXPO_PUBLIC_SHOTS_CLOCK;
  if (!raw) return null;

  const parsed = new Date(raw).getTime();
  if (Number.isNaN(parsed)) {
    // Throwing is deliberate. A silent fall back to the real clock would
    // produce screenshots that look pinned, diff clean once, and then fail a
    // day later for a reason nobody can reconstruct. You only ever see this
    // if you set the variable yourself.
    throw new Error(
      `EXPO_PUBLIC_SHOTS_CLOCK="${raw}" is not a parseable date. Use a local ` +
        `ISO date-time with no timezone suffix, e.g. "${EXAMPLE}". ` +
        `A trailing "Z" would pin UTC, which makes the greeting depend on the ` +
        `capturing machine's timezone.`,
    );
  }
  return parsed;
}

// Read once at module load. A pin that drifted between calls would defeat the
// purpose, and the environment cannot change under a running bundle anyway.
const PINNED_MS = readPin();

/**
 * The current instant, or the pinned one when the harness has set it.
 * Use this anywhere a Date is READ for display or for a query key.
 */
export function now(): Date {
  return PINNED_MS === null ? new Date() : new Date(PINNED_MS);
}

/**
 * The device-local calendar date as YYYY-MM-DD, honouring the pin.
 * "en-CA" is the locale that yields YYYY-MM-DD — same convention as
 * src/lib/localDate.ts, so pinned and unpinned rows agree by construction.
 */
export function todayLocalDate(): string {
  return now().toLocaleDateString("en-CA");
}

/** True when a fixed clock is in force. Never true in a release build. */
export function isClockPinned(): boolean {
  return PINNED_MS !== null;
}
