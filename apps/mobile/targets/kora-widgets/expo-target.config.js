/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  const appGroups = config.ios?.entitlements?.["com.apple.security.application-groups"];
  if (!appGroups) {
    throw new Error(
      "kora-widgets/expo-target.config.js: app.config's ios.entitlements is missing " +
        "'com.apple.security.application-groups'. The widget target shares this App Group " +
        "with the app to read the nutrition snapshot — add it to the app's entitlements " +
        "before building the widget target.",
    );
  }

  return {
    type: "widget",
    // No hyphen: EAS registers credentials under the sanitized name
    // ("korawidgets") and its worker looks the native target up by EXACT
    // name — "kora-widgets" here made remote builds fail with
    // "Could not find target 'korawidgets' in project.pbxproj".
    name: "korawidgets",
    // AppIntentConfiguration (the metric picker) requires iOS 17. This raises
    // the EXTENSION only — the app stays at 16.4, so iOS 16 users keep the app
    // and simply see no Kora widgets in the gallery. @bacons/apple-targets maps
    // this to IPHONEOS_DEPLOYMENT_TARGET on the target's build configuration.
    deploymentTarget: "17.0",
    displayName: "Kora",
    bundleIdentifier: ".widgets",
    // HealthKit is read live inside KoraWidget's provider (Task 6/10); the App
    // Group carries the snapshot the app writes (Task 2). Both must be on the
    // TARGET, not just the app — an extension is a separate process with its
    // own entitlements.
    entitlements: {
      "com.apple.security.application-groups": appGroups,
      "com.apple.developer.healthkit": true,
    },
    frameworks: ["SwiftUI", "WidgetKit", "HealthKit", "AppIntents"],
  };
};
