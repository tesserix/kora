---
status: complete
issue: 420
---

# 420 — a locked device made the steps widget say it had no Health access

## What changed

- `StepReading.Availability` (`readable` / `locked` / `unreadable`) — a pure,
  Foundation-only decision, symlinked into the test package like the rest of
  the widget's logic.
- `HealthReader.cumulativeSum` now returns `(sum, inaccessible)` instead of
  discarding the query error. `errorDatabaseInaccessible` is the only way to
  tell a locked store from a denied read.
- `todaySteps()` returns `StepRead` (the figure plus why it is missing).
- The timeline refreshes in **5 minutes** after a locked read, 30 as before
  otherwise. `.unreadable` deliberately keeps the slow cadence: nothing about
  it changes on its own, and retrying would burn the daily refresh budget.
- Medium's history line says "Unlock to update" rather than
  "Health access needed" when the cause was the lock.

## Tests

Seven new. Compile-level RED first (both symbols missing), then
**mutation-checked**: collapsing `availability` back to always-`.unreadable`
failed exactly `testNoEvidenceWithLockedStoreIsLocked` and
`testNonFiniteSumIsNotEvidenceOfAReadableStore`. 56 swift tests green.

The whole widget target `swiftc -typecheck`s clean against the iOS 26.5 SDK,
which covers HealthReader / KoraWidget / MediumView — the files the SwiftPM
package cannot reach.

## Correction to the issue as filed

#420 said the locked state renders "Open Kora to see your steps". It does not:
that copy is `forMissingSnapshot`, for a signed-out or never-opened app. The
locked state renders a `—` dial, and on medium the line "Health access needed"
— which is still wrong for the same reason, and is what changed.

## Not verified

The lock trigger itself is still **inferred**, not observed. Nothing here
proves a locked device is what produces the blank widget; it proves that IF it
is, the widget now recovers in ~5 minutes and stops blaming permissions.
