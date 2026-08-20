# Golden screenshots

Committed reference images for the screenshot harness (kora#257 Stage C).
One PNG per route per content size, at **1x (440x956)** — box-averaged 3x3 down
from the simulator's native 3x capture. `manifest.json` records the device,
runtime, clock pin and rule parameters they were produced with; a comparison
against a capture that differs in any of those is refused rather than fudged.

## Check a build against them

```
# Metro must be started with the SAME clock pin — it inlines the value.
EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
npx expo start --dev-client --port 8083

EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 \
npm run shots -- --content-size medium --out .shots/medium --port 8083

npm run shots:compare -- --candidate .shots/medium
```

Sign in on the simulator by hand first; the harness does not script sign-up.

## Accept a change

Only when you have looked at the images and the change is intended:

```
EXPO_PUBLIC_SHOTS_CLOCK=2026-08-19T09:41:00 npm run shots:golden -- --port 8083
```

There is no `--force` and no `--update` on the comparator, deliberately.

## Not every route is here

`manifest.json` lists the excluded routes and why. The reasons live in
`scripts/shots.goldens.mjs`; each says what would have to change to bring the
route back. A route is excluded when it cannot hold still — never by loosening
the rule until it passes.

## The rules

See `scripts/shots.goldens.mjs` for the numbers and the measurements behind
each one, and `scripts/shots-blocks.mjs` for why there are three of them.
In short: no pixel over 48/255, no more than 3% of the frame over 8/255, no
20px block more than 30% dense.

## Not wired into CI

Running this needs a booted iPhone 17 Pro Max, a dev client, Metro and a
signed-in simulator. kora#262's macos-26 runner makes it possible; whether it
is worth the minutes is a separate decision.
