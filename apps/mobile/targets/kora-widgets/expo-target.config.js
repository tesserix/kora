/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "kora-widgets",
  displayName: "Kora",
  bundleIdentifier: ".widgets",
  // HealthKit is read live inside StepsWidget (Task 6); the App Group carries
  // the snapshot the app writes (Task 2). Both must be on the TARGET, not just
  // the app — an extension is a separate process with its own entitlements.
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
    "com.apple.developer.healthkit": true,
  },
  frameworks: ["SwiftUI", "WidgetKit", "HealthKit"],
});
