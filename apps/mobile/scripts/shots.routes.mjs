/**
 * The route list the screenshot harness walks.
 *
 * This is the one place to edit when adding a screen. Keep it declarative:
 * `shots.mjs` does not know anything about the app beyond what is here.
 *
 *   name   - filename stem and manifest key. Must be unique and path-safe.
 *   path   - the deep-link path, appended to the scheme. "/" is the first tab.
 *   auth   - "public"    reachable signed out
 *            "required"  needs a signed-in simulator; captured anyway when
 *                        signed out, and flagged in the manifest.
 *   ready  - REQUIRED. Accessibility text that must ALL be present before the
 *            shutter fires. See "Readiness, not timers" below.
 *   allow  - optional. Substrings to exempt from NOT_READY for this route, for
 *            a screen whose real copy collides with a not-ready marker.
 *   settle - optional extra dwell (ms) AFTER readiness, for animation only.
 *            It is no longer the mechanism that decides when to shoot; a route
 *            that needs a big number here is telling you its `ready` selector
 *            is matching too early.
 *   note   - free text carried into the manifest, for anything a reviewer of
 *            the images would otherwise have to rediscover.
 *
 * ---------------------------------------------------------------------------
 * Readiness, not timers (kora#257 Stage B)
 * ---------------------------------------------------------------------------
 * #272 measured this harness's noise floor and found the renderer is
 * essentially deterministic — 84 within-launch comparisons, not one pixel above
 * 4/255. Every large across-launch difference was a picture of a DIFFERENT
 * SCREEN: a route that had reached "Loading…" or "Couldn't load your profile —
 * Retry" when the fixed `settle` timer expired. `ai-usage` differed by 47.8% of
 * the frame that way.
 *
 * A fixed timer cannot fix that. It is simultaneously too slow for a static
 * screen and too fast for a cold fetch, and no pixel tolerance can absorb a
 * 250/255 delta over half the frame.
 *
 * So the shutter now waits on the accessibility tree (`idb ui describe-all`):
 * every string in `ready` must be present, and no NOT_READY marker may be. A
 * route that never becomes ready FAILS the run loudly rather than recording the
 * wrong screen — the whole point of Stage C is trusting these images.
 *
 * Choosing a `ready` selector: pick text that only exists once the screen's
 * data has landed, not chrome that renders immediately. A screen title is
 * usually a BAD selector (it renders during the loading state too); a section
 * header inside the data-backed region is usually a good one.
 */

/**
 * Text that means "this screen is mid-flight or broken" wherever it appears.
 * Matched as a substring against every accessibility label and value on screen.
 * A route can exempt individual entries via its `allow` list.
 */
export const NOT_READY = [
  "Loading…",
  "Loading...",
  "Retry",
  "Try again",
  "Couldn't",
  "couldn't",
  "Something went wrong",
];

/**
 * Text that means the capture is polluted by a build/environment defect rather
 * than by app state. These do NOT block the shutter — they are recorded in the
 * manifest as `renderErrors` and summarised at the end of the run, because a
 * golden captured over one of these would enshrine it.
 *
 * The live example is a dev client built before `expo-linear-gradient` was
 * added: every gradient renders as a red LogBox box instead. That is a one-time
 * `npx expo run:ios` away, not a harness problem — see the Stage B report.
 */
export const RENDER_ERRORS = ["Unimplemented component"];

export const routes = [
  {
    name: "sign-in",
    path: "/sign-in",
    auth: "public",
    ready: ["Welcome back.", "Continue with email"],
  },
  {
    name: "onboarding",
    path: "/onboarding",
    auth: "public",
    // The plan summary at the bottom is computed from the slider defaults, so
    // its presence proves the whole form mounted, not just the header.
    ready: ["YOUR GOAL", "Daily target", "Start with this plan"],
  },

  // The four tabs.
  {
    name: "tab-today",
    path: "/",
    auth: "required",
    // "ENERGY RESERVE" lives inside the dashboard card and only exists once
    // useDashboard resolves; the "Today" title renders during loading too.
    ready: ["ENERGY RESERVE", "Logged today"],
  },
  {
    name: "tab-diary",
    path: "/diary",
    auth: "required",
    ready: ["DAY TOTAL", "Water"],
  },
  {
    name: "tab-progress",
    path: "/progress",
    auth: "required",
    ready: ["Energy vs budget", "Logging streak"],
  },
  {
    name: "tab-more",
    path: "/more",
    auth: "required",
    // "Your account" is the header subtitle; the account row below it carries
    // the signed-in email, which is what proves the profile query landed.
    ready: ["Your account", "Sign out", "@"],
  },

  {
    name: "recipes",
    path: "/recipes",
    auth: "required",
    // Either the list or its empty state — both mean the query settled. The
    // loading state has neither.
    ready: ["Your recipes"],
    readyAny: ["No recipes yet", "servings"],
  },
  {
    name: "settings",
    path: "/settings",
    auth: "required",
    ready: ["UNITS", "REMINDERS", "WEIGHT CHECK-IN"],
  },
  {
    name: "profile",
    path: "/profile",
    auth: "required",
    ready: ["DAILY TARGETS", "MEMBER SINCE", "ACCOUNT"],
  },
  {
    name: "notifications",
    path: "/notifications",
    auth: "required",
    ready: ["Recent"],
    readyAny: ["Nothing yet", "ago"],
  },
  {
    name: "about",
    path: "/about",
    auth: "public",
    ready: ["USDA FoodData Central", "Version"],
  },
  {
    name: "coach",
    path: "/coach",
    auth: "required",
    // TODAY'S FOCUS is the nudge card, Conversation is the thread below it.
    // Both fetch separately, and #272 caught a run where the second failed
    // while the first succeeded — requiring both is what makes that loud.
    ready: ["TODAY'S FOCUS", "Conversation", "Send question"],
  },
  {
    name: "ai-usage",
    path: "/ai-usage",
    auth: "required",
    // The 47.8%-of-frame row in #272's report. QUOTA WINDOWS is inside the
    // quota card and exists only after the usage query resolves.
    ready: ["QUOTA WINDOWS", "Cached matches"],
  },
  {
    name: "feedback",
    path: "/feedback",
    auth: "required",
    ready: ["Help us improve", "Subject", "Send"],
  },
];

/**
 * Content sizes worth capturing. `medium` is the iOS default; the
 * accessibility sizes are where text-scaling bugs live (kora#260).
 * Any value `xcrun simctl ui <udid> content_size` accepts works on the CLI —
 * these are just the named presets.
 */
export const contentSizes = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
];
