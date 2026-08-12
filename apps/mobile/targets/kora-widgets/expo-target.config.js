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
    displayName: "Kora",
    bundleIdentifier: ".widgets",
    // HealthKit is read live inside StepsWidget (Task 6); the App Group carries
    // the snapshot the app writes (Task 2). Both must be on the TARGET, not just
    // the app — an extension is a separate process with its own entitlements.
    entitlements: {
      "com.apple.security.application-groups": appGroups,
      "com.apple.developer.healthkit": true,
    },
    frameworks: ["SwiftUI", "WidgetKit", "HealthKit"],
  };
};
