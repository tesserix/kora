# Kora widgets — one configurable instrument

**Date:** 2026-08-12
**Status:** Approved direction
**Supersedes:** the two-widget lineup (`NutritionWidget` + `StepsWidget`) shipped through EAS build #14
**Design language:** `docs/superpowers/specs/2026-08-11-kora-instrument-glass-design.md`

## Direction

Replace the two separate widgets with **one configurable Kora widget**. The user
picks which metric it shows; the widget's job is to answer "how am I doing?" at a
glance and, on tap, land the user exactly where that metric lives.

The steps widget has been out of the bundle since 2026-08-12 because it renders a
denied HealthKit read as a confident `0`. That bug is the centre of this design,
not an afterthought: the invariant below is what the whole thing is built around.

> **`nil` and `0` are different answers and must never render the same way.**

## Decisions

| Decision | Choice | Rejected alternatives |
| --- | --- | --- |
| Lineup | One widget, user-configurable via `AppIntentConfiguration` | Two fixed widgets; one size-tiered widget with no configuration |
| Metrics | Reserve (default), Steps, Protein | Weight — no target to fill against, so no dial, and it changes least between glances |
| Visual treatment | System `containerBackground`, instrument drawn as content | Full Kora ground (fights iOS 18 tinting); system material with accent only (not recognisably Kora) |
| Home families | `systemSmall`, `systemMedium`, `systemLarge` | — |
| Lock Screen | `accessoryRectangular`, `accessoryInline` | `accessoryCircular` — the tick dial does not survive iOS's flat white mask at 64pt |
| Medium content | Deepens the chosen metric | Broadening to all metrics (weakens the point of configuring) |
| Tap behaviour | Contextual deep link per metric | Explicit capture button; interactive in-place logging |
| iOS floor | Widget extension targets iOS 17; app stays 16.4 | Raising the whole app; shipping a static iOS 16 fallback widget |

Out of scope: StandBy, interactive logging (`AppIntent` buttons), Control Center
controls, the weight metric, `accessoryCircular`.

## Architecture

`KoraWidget` replaces `NutritionWidget` and `StepsWidget`. `AppIntentConfiguration`
with a `MetricIntent` (`AppEnum`: `reserve` | `steps` | `protein`, default
`reserve`).

### Two data sources, deliberately different

**Reserve and Protein** read the App Group snapshot the app already writes
(`group.com.tesserix.kora`, key `nutritionSnapshot`). No permissions, no queries.
`WidgetBridgeModule.setSnapshot` already calls `WidgetCenter.shared.reloadAllTimelines()`
on every write, so these are push-fresh; the timeline only needs an entry at local
midnight so the day rolls over.

`buildSnapshot` already carries protein, so **the wire format does not change** and
the app-side work for this design is close to zero.

**Steps** is read live from HealthKit inside the extension. It is the only path that
can fail.

### The unknown-vs-zero resolution

iOS deliberately will not disclose whether an app holds *read* permission —
`authorizationStatus(for:)` reports `.notDetermined` for a denied read, by design.
A denied read and a genuinely stepless morning are therefore indistinguishable from
a single query. The current `StepReader.todaySteps` resolves that ambiguity by
returning `0`, which is the bug.

The widget mirrors what `useHealth` does in the app:

1. `HKStatisticsQuery` for today, `.cumulativeSum`, local midnight → now.
2. If `sumQuantity()` is **present** → that is the answer, including a real `0`.
3. If **absent** → probe the last 7 days with a second statistics query.
   - Probe finds samples → today is a genuine `0`.
   - Probe finds nothing → the answer is **unknown** (`nil`), rendered `—`.

**Rejected:** carrying a `stepsReadable` flag in the snapshot to save the second
query. The user can revoke Health access in Settings after the app last wrote,
leaving a stale `readable: true` that puts the confident zero straight back on the
home screen. The probe cannot go stale because it runs at read time.

### Refresh

Steps timelines request a reload every **30 minutes**. Not 15 as today: WidgetKit's
daily budget is roughly 40–70 refreshes and 15 minutes asks for 96, so iOS throttles
and the widget ends up *less* fresh than a smaller ask would be. Reserve and Protein
rely on the app's push reload plus a local-midnight entry.

## Layouts

Identity is carried entirely by content: tick dial, accent needle and hub, mono
tabular numerals, engraved uppercase labels. The ground stays the system
`containerBackground` so iOS 18 tinting and vibrancy keep working. Accent appears
only on the needle and hub, redline/over-target states, and goal-hit history bars.
**The existing `.tint(.green)` progress bar is removed** — the design language
admits no new green.

**`systemSmall`** — engraved metric label; tick dial with the needle at
`value / target`; hero numeral in mono tabular figures; engraved caption. One
structure for all three metrics; only label, fraction and caption change.

**`systemMedium`** — dial left, expansion right:
- *Reserve* → protein track full-width, carbs and fat tracks paired beneath.
- *Protein* → dial on protein, with carbs and fat tracks plus the reserve figure
  as context.
- *Steps* → 7-day bar history, accent on goal-hit days, with average and goal-day
  count. Needs a second HealthKit call (`queryStatisticsCollection`, 7 daily
  buckets) — the one place the Steps configuration costs materially more.

**`systemLarge`** — always the whole day regardless of configured metric: reserve
dial, macro tracks, steps and sleep figures, then today's logged meals with mono
times and kcal. The only family with room for legible secondary figures.

**`accessoryRectangular`** — engraved label, mono value, thin progress track.
Typographic, so it survives the white mask.

**`accessoryInline`** — one line beside the clock: `6,420 of 10,000`.

### Tap targets

`widgetURL` by configured metric: Reserve and Protein → `mobile:///` (Today),
Steps → `mobile:///progress` (Trends — the URL the existing `StepsWidget` already
uses; expo-router route groups such as `(tabs)` do not appear in the URL). On
`systemLarge`, meal rows get their own
`Link` destinations into `mobile:///meal?id=…` — large is the only family with room
for distinct tap regions.

## States

Each is a different fact. None collapse into a confident number.

| State | Render |
| --- | --- |
| No snapshot (signed out, or never opened) | "Open Kora" + per-metric caption |
| Stale snapshot (describes a previous day) | "Open Kora to see today" |
| Steps unknown (probe empty) | `—`; medium adds "Health access needed" |
| Steps genuinely zero (probe found samples, today none) | `0` |
| Over target (reserve < 0, or steps/protein past goal) | Redline ticks in accent, numeral shows overage |
| HealthKit unavailable (iPad, no HealthKit) | `—`, same path as unknown |
| Gallery placeholder | Representative figures, never zeros |

The no-snapshot state is also the **issue #135** privacy path: `clearSnapshot()` on
sign-out plus `reloadAllTimelines()` removes both the previous user's calories and
their steps context from the home screen. That path has been reviewed end-to-end but
never observed live; its device verification is folded into this work.

**Midnight reset — considered and rejected.** Treating midnight as "nothing eaten
yet, so kcal left is just the target" is tempting and wrong here: the API buckets by
UTC, so a 12:43 AM local log lands on the previous local day. Assuming zero would
render a confident full budget over a meal that was genuinely logged. The honest
empty state beats a plausible wrong number.

**Authorization.** A widget extension cannot call `requestAuthorization` — only the
app can. The unknown state therefore always deep-links into the app rather than
implying the widget itself can fix it.

## Testing

**Swift, pure logic.** `widget-core-tests/` is an SPM package that mirrors
`Snapshot.swift` into `KoraWidgetCore` so `swift test` exercises it without a
simulator. Everything decidable moves there and gets tests in the style of
`SnapshotTests.swift`:
- unknown-vs-zero resolution (all four branches: present sum, present zero, absent
  with samples in the probe window, absent with an empty probe)
- dial fraction and redline classing, including over-target
- stale-snapshot guard across a midnight boundary
- metric selection and per-metric deep-link target

**TypeScript, jest.** `buildSnapshot` is unchanged; existing tests stand. Any change
to the snapshot shape must change `Snapshot.swift` in the same commit — they are one
wire format.

### Device gates

Neither suite can catch these, and gate 2 is why the widget is currently out of the
bundle:

1. **Steps, Health granted** — widget matches the Health app *and* matches Home.
   Both now use cumulative-sum, so a Watch user should see them agree for the first
   time.
2. **Steps, Health denied** — renders `—`, not `0`. **Blocking gate.**
3. **Sign out** — both metrics revert to "Open Kora" (issue #135).
4. **Midnight rollover** — stale snapshot does not render yesterday as today.
5. **Lock Screen** — rectangular and inline legible under the white mask.
6. **iOS 18 tinted home screen** — the reason the hybrid treatment was chosen.
7. **Configuration** — long-press → Edit switches metric on all families.

**If gate 2 cannot be run**, the widget ships with Reserve and Protein only and
Steps stays out until it can. A smaller lineup beats the confident-zero bug
returning to the home screen.

## Build and release constraints

- **No EAS builds are to be triggered from this work** until explicitly requested.
- The widget target must stay named `korawidgets` (no hyphen) in
  `targets/kora-widgets/expo-target.config.js` — EAS credentials use the sanitized
  name and the worker looks it up exactly.
- `ios.appleTeamId` must remain set in `app.json`.
- Any dependency change requires `npx npm@10.9.3 install --package-lock-only`
  (EAS runners use npm 10).
- Raising the extension's deployment target to iOS 17 is a native project change:
  verify it survives prebuild and does not raise the app target with it.

## Follow-ups (not this spec)

- **Ask Otto** — the coach surface (`/v1/coach/ask`, `/v1/coach/nudges`,
  `/v1/coach/thread`) needs its own brainstorm once widgets land.
- `useActivityHistory` still sums raw `queryQuantitySamples` for per-day bucketing
  and inherits the multi-source inflation this spec fixes elsewhere, skewing the
  inferred activity level and therefore the calorie target. Own task.
