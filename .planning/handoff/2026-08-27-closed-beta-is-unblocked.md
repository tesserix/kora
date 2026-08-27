# Handoff — the closed beta is unblocked and the build is in TestFlight

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch.

**There is ONE real user — the owner.** Still the most useful fact for judging
urgency. **The repo is PUBLIC**: never put a real weight, measurement or intake
value in a commit, comment, test fixture, issue or PR. Describe results as counts.

`main` is at **`e97ac585`**.

## The single most important thing

**Nothing blocks the cohort.** All three #328 entry criteria are closed (#43,
#24, #105), nutrition is at **43/50 (86%)** measured against production, and a
TestFlight build off `e97ac585` was submitted and accepted on 2026-08-27.

So the next useful work is **not more engineering**. `food_resolution_outcomes`
is at **0 rows** and #212's own binding constraint is *"real user queries for the
fixture — they are all queries I chose."* Fifty phrases I invented are a worse
instrument than one week of testers. Grinding nutrition further optimises against
imagination while the real signal sits unused.

## Week one: watch the inbox, and distrust an empty one

`below_floor` and `no_match` items appearing in `/admin/inbox` is the first live
proof the resolution-outcome path works end to end. It is **tested but has never
executed in production** — #459 shipped after the last real activity.

**A broken recorder and a genuinely clear queue look identical from outside.** If
testers are clearly logging and the queue stays empty, investigate rather than
relax. That queue is the metric #328 calls the most important one.

## Decisions made — do not relitigate

- **ADR 0004: StoreKit IAP is the rail for AI top-ups on iOS**, in a
  **subscription + consumable top-ups** shape. Guideline 3.1.1 requires IAP for
  in-app credits, and Australia — the home market and the cohort's storefront —
  has **no external-purchase entitlement**. Stripe (#478) is merged and stays
  **configured-off**; it is for a future WEB checkout. #479's trigger ("once
  Stripe orders settle") likely never fires as written.
- **#447 is REVERSED**: the console **controls and manages** Kora. Recorded in
  `docs/admin-contract.md`, with the superseded decision kept beneath because its
  reasoning still governs how writes are added.
- **`add-alias` and `resolve-to-food` are NOT offered from the console**, and
  this is the live open decision. A curated alias resolves at score **1.0 — the
  auto-log tier** — so a wrong one silently logs the wrong food for everyone.
  Aliases live in a reviewed file where each carries a stated `why`; a console
  button removes the REVIEW, not the work.
- **Deliberately not aliased**: bare `chips` (crisps vs hot chips, ~2x),
  `iced coffee` (cafe vs bottled milk drink) — real ambiguity to ask about; and
  `souvlaki` / `hsp`, which have **no generic row at all**. That is a DATA gap,
  and pointing them at a near-neighbour would settle a different food at 1.0.
- **#485's premise is accurate but its urgency is overstated.** Spend is $0.06
  against a $500 cap — ~1000x away, not a beta risk.

## Traps that cost time today

- **An alias target must be PORTIONABLE, not just the right food.** It resolves
  at auto-log, and a row with no serving data sends every portion through
  `defaultPortionGrams` (100g). AUSNUT's flat-white row would have logged HALF a
  240ml drink. **4,807 of 26,120 prod rows have no serving size** — provenance
  quality and loggability are different axes.
- **`ServingUnits` is `json.RawMessage`, so an empty list is the two bytes `"[]"`
  and `len(x) == 0` is ALWAYS FALSE.** Decode with `units.DecodeServingUnits`.
  I shipped a check using the naive len() that warned about nothing while
  carrying a comment about how important it was.
- **Dev and prod diverge** — 18,876 rows vs 26,120, 67% vs 82% serving coverage.
  **Run the eval harness against PROD** (it is read-only; the README has the
  command). `long black` passed on dev and MISSED on prod.
- **The harness HIT rate is a REGRESSION PIN, not accuracy.** Expectations are
  chosen by looking at what the resolver already returns. Harness said 43/43 HIT
  while real accuracy was 86%. Never quote the first as the second.
- **Retrieval bounds ranking.** `resolveScanLimit` is 100; "beef" recalls 1,462
  rows. Print the candidate set before theorising about scores.
- **`expo install --fix` does not complete** — ERESOLVE on
  `@react-native/jest-preset`. Deleting only the lockfile is not enough either;
  delete **both** `package-lock.json` and `node_modules`, then `npm install`.
- **tesserix-k8s requires a human review** (`REVIEW_REQUIRED`) and `ct lint`
  requires a **Chart.yaml version bump** on any chart change.
- **GitHub Actions can be slow to queue.** I twice declared "CI did not trigger"
  and the run appeared seconds later. Wait before concluding.

## Verification practice that earned the most

**Mutation testing caught three of my own tests checking nothing**, again. Also:
one test asserted only that a route was mounted and would have passed whatever
the value was; one "killed" a mutation for the wrong reason (the row was absent
from the fixture, not the property under test) until the fixture was fixed.

**Premise-check every issue before building on it.** An audit of ten open issues
found **six** with a stale central claim — #307, #157 and #152 were closed as
already-fixed. Every one was TRUE when written; they decayed because something
else moved. Nothing re-checks, so nothing catches it.

Also still true: check the exit code rather than the summary, a skipped test is
not a pass, and run DB suites twice confirming tables return to zero.

## Outstanding

- **The 13 issues under "Kora governed AI platform pilot"** (#380-#391, #395)
  have **never been premise-audited**. Given six of ten failed on the main board,
  do that before starting that milestone.
- **Retitles owed**: #234 (only `Red Rooster chips` survives), #417 (the label
  half is fixed; the 16h window remains).
- **tesserix-home#368** logs the console write-actions request (suspend, delete,
  credits, trials). Credits and trials are **blocked on the pricing model**, not
  on engineering. `ai_entitlements.order_id` is `NOT NULL UNIQUE REFERENCES
  ai_payment_orders(id)`, so a comped credit has nowhere to come from — the same
  schema change #487 needs.
- **The Stripe aliases/secrets are NOT in production.** tesserix-k8s#647 is
  merged with `stripe.enabled: false`; going live needs the two GSM secrets
  created first, or ESO fails the WHOLE ExternalSecret and takes kora-api down.
- `STRIPE_RETURN_URL` defaults to `mobile://billing/return` and **Stripe may
  reject a custom scheme** for `success_url`. Unverified.

Next local iOS build: `npx expo prebuild -p ios` (the `ios/` directory is
gitignored). I regenerated it today and `xcodebuild` succeeded on this tree.
