// Dynamic config, for ONE reason: the Android Firebase file is supplied by an
// EAS environment variable rather than committed.
//
// app.json remains the source of truth for everything else — it is passed in
// here as `config` and spread through unchanged. Adding a key belongs there,
// not here, unless it genuinely has to be computed at build time.
//
// # Why google-services.json is not in the repo
//
// It carries a Google api_key, and this repository is public. Committing it
// tripped gitleaks' `gcp-api-key` rule, correctly. The iOS
// GoogleService-Info.plist beside it survives the same rule only because the
// pattern matches a JSON `"key": "value"` and not the plist's XML — it passes
// by FORMAT, not by policy, so it is no precedent for adding a second one.
//
// EAS supplies the file at build time as a file-type environment variable,
// which materialises on disk and sets GOOGLE_SERVICES_JSON to its path.
//
// The fallback is for LOCAL work only: `expo prebuild` and a local Gradle
// build read ./google-services.json straight from the working tree, where it
// is gitignored. A local build without that file still succeeds — it simply
// produces an app whose Google Sign-In cannot work, which is the honest
// outcome and matches what happens when the variable is absent in CI.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json",
  },
});
