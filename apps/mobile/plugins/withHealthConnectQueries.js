const { withAndroidManifest } = require("expo/config-plugins");

// Health Connect's provider package, declared for PACKAGE VISIBILITY.
//
// Android 11+ hides other packages from an app unless it declares interest.
// react-native-health-connect talks to `com.google.android.apps.healthdata`
// (its DEFAULT_PROVIDER_PACKAGE_NAME), and without this entry the platform
// filters the interaction — logcat shows
// `AppsFilter: ... -> com.google.android.health.connect... BLOCKED` — so
// getSdkStatus can report the SDK unavailable on a device that has it.
//
// It matters most BELOW Android 14, where Health Connect is a separately
// installed app rather than a platform module. The library's own Expo plugin
// adds the permissions-rationale intent but not this, so it is added here.
const HEALTH_CONNECT_PACKAGE = "com.google.android.apps.healthdata";

module.exports = function withHealthConnectQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries ?? [];
    if (manifest.queries.length === 0) manifest.queries.push({});

    const queries = manifest.queries[0];
    queries.package = queries.package ?? [];
    const already = queries.package.some(
      (p) => p?.$?.["android:name"] === HEALTH_CONNECT_PACKAGE,
    );
    if (!already) {
      queries.package.push({ $: { "android:name": HEALTH_CONNECT_PACKAGE } });
    }
    return cfg;
  });
};
