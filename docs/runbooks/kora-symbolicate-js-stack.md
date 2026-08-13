# Turning a minified Crashlytics stack into a readable one

Crashlytics does not consume React Native source maps, so a JS stack in the
dashboard is minified. This is the accepted cost of choosing Crashlytics over
Sentry (see `docs/superpowers/specs/2026-08-13-kora-crash-reporting-design.md`).

## Before you reach for this

Most reports do not need a stack. Each carries `error_class`, `status`, `route`
and — for API failures — `request_id`. That last one appears verbatim in the Go
API's logs, which are not minified:

    kubectl --context=gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke \
      logs -n kora deploy/kora-api | grep '<request_id>'

Start there. Symbolicate only when the failure is genuinely client-side.

## Symbolicating

1. Read the **build number** from the Crashlytics report. Crashlytics records
   it natively from the binary, so there is no ambiguity about which build.
2. Download that build's source map from the EAS build's artifacts.
3. Save the minified stack to a file, then:

       npx metro-symbolicate /path/to/main.jsbundle.map < stack.txt

## Keeping the maps

Source maps are EAS build artifacts and expire. For any build distributed to
TestFlight, download the map and retain it for as long as that build is
installable — a map you cannot fetch makes this runbook useless exactly when
you need it.
