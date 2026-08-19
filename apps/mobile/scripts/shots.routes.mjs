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
 *   settle - optional per-route override, ms to wait after navigating before
 *            the shutter. Screens that fetch need longer than static ones.
 *   note   - free text carried into the manifest, for anything a reviewer of
 *            the images would otherwise have to rediscover.
 */
export const routes = [
  { name: "sign-in", path: "/sign-in", auth: "public" },
  { name: "onboarding", path: "/onboarding", auth: "public" },

  // The four tabs.
  { name: "tab-today", path: "/", auth: "required", settle: 4000 },
  { name: "tab-diary", path: "/diary", auth: "required", settle: 4000 },
  { name: "tab-progress", path: "/progress", auth: "required", settle: 4000 },
  { name: "tab-more", path: "/more", auth: "required" },

  { name: "recipes", path: "/recipes", auth: "required", settle: 4000 },
  { name: "settings", path: "/settings", auth: "required" },
  { name: "profile", path: "/profile", auth: "required", settle: 4000 },
  { name: "notifications", path: "/notifications", auth: "required" },
  { name: "about", path: "/about", auth: "public" },
  { name: "coach", path: "/coach", auth: "required", settle: 4000 },
  { name: "ai-usage", path: "/ai-usage", auth: "required", settle: 4000 },
  { name: "feedback", path: "/feedback", auth: "required" },
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
