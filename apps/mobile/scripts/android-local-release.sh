#!/usr/bin/env bash
# Build the production Android bundle on this Mac and submit it to the Play
# Console internal track.
#
#   ./scripts/android-local-release.sh              (run from apps/mobile)
#   ./scripts/android-local-release.sh --no-submit  build only
#
# This exists because android-release.yml builds on EAS's servers, and the
# free plan's Android builds can run out mid-month. A --local build runs the
# same profile on this machine and costs no build credits; the submit still
# goes through EAS, which is free. The versionCode still comes from EAS
# (appVersionSource: remote), so local and cloud builds never collide.
#
# Needs:
#   - google-services.json: $GOOGLE_SERVICES_JSON, else ./google-services.json.
#     It is gitignored (public repo), so it is never in a fresh checkout.
#   - JDK 17: $JAVA_HOME, else whatever `java_home -v 17` finds.
#   - Android SDK: $ANDROID_HOME, else ~/Library/Android/sdk.
#   - SENTRY_AUTH_TOKEN for symbolicated JS crashes. Without it the build
#     still works, but skips the source-map upload, so Sentry shows minified
#     stack traces for this build.
set -euo pipefail

MOBILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE"

submit=true
case "${1:-}" in
  "") ;;
  --no-submit) submit=false ;;
  *) echo "usage: $0 [--no-submit]" >&2; exit 2 ;;
esac

die() { echo "$*" >&2; exit 1; }

# A local EAS build packs the last commit, not the working tree, so
# uncommitted edits would silently be left out of what testers get.
git diff --quiet HEAD -- . || die "apps/mobile has uncommitted changes; commit or stash them first."

export GOOGLE_SERVICES_JSON="${GOOGLE_SERVICES_JSON:-$MOBILE/google-services.json}"
[ -f "$GOOGLE_SERVICES_JSON" ] ||
  die "google-services.json not found at $GOOGLE_SERVICES_JSON (set GOOGLE_SERVICES_JSON, or copy it into apps/mobile)."
grep -q '"package_name": *"com.tesserix.kora"' "$GOOGLE_SERVICES_JSON" ||
  die "$GOOGLE_SERVICES_JSON has no client for com.tesserix.kora."

export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}"
[ -x "${JAVA_HOME:-}/bin/java" ] || die "JDK 17 not found; install one or set JAVA_HOME."
"$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "17' || die "JAVA_HOME is not JDK 17: $JAVA_HOME"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME/platform-tools" ] || die "Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)."

if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
  echo "SENTRY_AUTH_TOKEN not set: skipping the Sentry source-map upload for this build." >&2
  export SENTRY_DISABLE_AUTO_UPLOAD=true
fi

out="$MOBILE/dist/android/kora-$(git rev-parse --short HEAD).aab"
mkdir -p "$(dirname "$out")"

npx eas-cli build --platform android --profile production --local --non-interactive --output "$out"
echo "Built $out"

if $submit; then
  npx eas-cli submit --platform android --profile production --path "$out" --non-interactive --wait
fi
