# Kora Configurable Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `NutritionWidget` and `StepsWidget` with one user-configurable `KoraWidget` offering Reserve / Steps / Protein, where a denied HealthKit read renders `—` and never a confident `0`.

**Architecture:** All decidable logic lives in pure Swift files under `targets/kora-widgets/`, symlinked into the `widget-core-tests` SPM package so `swift test` exercises exactly the code that ships. SwiftUI views and HealthKit queries are thin shells over that logic. Configuration uses `AppIntentConfiguration` (iOS 17), so the widget extension's deployment target rises to 17 while the app stays at 16.4.

**Tech Stack:** Swift 5.9, SwiftUI, WidgetKit, AppIntents, HealthKit, `@bacons/apple-targets`, Expo SDK 57 / RN 0.86, XCTest via SwiftPM.

**Spec:** `docs/superpowers/specs/2026-08-12-kora-widgets-design.md`

## Global Constraints

- **Do NOT trigger EAS builds.** No `eas build` from any task in this plan.
- The widget target must stay named `korawidgets` (no hyphen) in `targets/kora-widgets/expo-target.config.js`. EAS credentials use the sanitized name and the worker looks it up exactly.
- `ios.appleTeamId: "2CRHRRYBPL"` must remain in `app.json`.
- Any dependency change requires `npx npm@10.9.3 install --package-lock-only` (EAS runners use npm 10.9).
- No new npm dependencies are expected. If one becomes necessary, stop and ask.
- **Invariant, above all others:** `nil` and `0` are different answers and must never render the same way.
- Accent `#FF4A00` appears only on the dial needle and hub, redline ticks, and goal-hit history bars. No green anywhere — the existing `.tint(.green)` is removed.
- Pure-logic files under `targets/kora-widgets/` that are symlinked into the SPM package may import **only `Foundation`**. Importing SwiftUI, WidgetKit, AppIntents, or HealthKit into them breaks `swift test` on macOS.
- **Use default (internal) access in every new Swift file — no `public`.** The existing `NutritionSnapshot` and `SnapshotLogic` are internal, so a `public` function taking a `NutritionSnapshot` fails to compile with "cannot be declared public because its parameter uses an internal type". The SPM tests reach internal symbols via `@testable import KoraWidgetCore`, exactly as `SnapshotTests.swift` already does.
- No `@available(iOS 17.0, *)` annotations are needed anywhere: the extension's deployment target is 17.0, so the whole target is gated. Adding them to some types but not the `WidgetBundle` causes an availability mismatch at `@main`.
- Run `swift test` from `apps/mobile/widget-core-tests`. Baseline before this plan: 6 tests passing.
- Run the JS suite with `npm test` from `apps/mobile`. Baseline: 149 suites / 1181 tests passing.
- Single-line conventional commit messages. No signatures.

---

### Task 1: Pure metric model

Defines what each configurable metric *is* — its engraved label, hero numeral, caption, dial fraction, over-target state, and deep link — as a pure function of the snapshot plus (for steps) a resolved step count.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/MetricKind.swift`
- Create (symlink): `apps/mobile/widget-core-tests/Sources/KoraWidgetCore/MetricKind.swift`
- Create: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/MetricKindTests.swift`

**Interfaces:**
- Consumes: `NutritionSnapshot` from the existing `Snapshot.swift`.
- Produces: `MetricKind` (`.reserve`, `.steps`, `.protein`), `MetricPresentation`, and `MetricKind.present(snapshot:steps:) -> MetricPresentation`. Tasks 4–10 all consume these.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/MetricKindTests.swift`:

```swift
import XCTest
@testable import KoraWidgetCore

private let snap = NutritionSnapshot(
  date: "2026-08-12", kcalConsumed: 1271, kcalTarget: 2451,
  proteinConsumed: 88, proteinTarget: 160,
  carbsConsumed: 110, carbsTarget: 260,
  fatConsumed: 57, fatTarget: 80, stepGoal: 10000
)

final class MetricKindTests: XCTestCase {
  func testReserveShowsRemainingKcalAndFillsByConsumption() {
    let p = MetricKind.reserve.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.label, "RESERVE")
    XCTAssertEqual(p.heroText, "1,180")
    XCTAssertEqual(p.caption, "KCAL LEFT")
    XCTAssertEqual(p.fraction, 1271.0 / 2451.0, accuracy: 0.0001)
    XCTAssertFalse(p.isOverTarget)
    XCTAssertEqual(p.deepLink, "mobile:///")
  }

  func testReserveOverBudgetShowsOverageAndFlagsRedline() {
    let over = NutritionSnapshot(
      date: "2026-08-12", kcalConsumed: 2700, kcalTarget: 2451,
      proteinConsumed: 88, proteinTarget: 160, carbsConsumed: 110, carbsTarget: 260,
      fatConsumed: 57, fatTarget: 80, stepGoal: 10000
    )
    let p = MetricKind.reserve.present(snapshot: over, steps: nil)
    XCTAssertEqual(p.heroText, "249")
    XCTAssertEqual(p.caption, "KCAL OVER")
    XCTAssertTrue(p.isOverTarget)
  }

  // THE invariant: an unknown step count must not become a confident zero.
  func testStepsUnknownRendersEmDashNotZero() {
    let p = MetricKind.steps.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.heroText, "—")
    XCTAssertNotEqual(p.heroText, "0")
    XCTAssertEqual(p.fraction, 0)
    XCTAssertEqual(p.deepLink, "mobile:///progress")
  }

  func testStepsKnownZeroRendersZero() {
    let p = MetricKind.steps.present(snapshot: snap, steps: 0)
    XCTAssertEqual(p.heroText, "0")
  }

  func testStepsFormatsWithGroupingAndGoalCaption() {
    let p = MetricKind.steps.present(snapshot: snap, steps: 6420)
    XCTAssertEqual(p.heroText, "6,420")
    XCTAssertEqual(p.caption, "OF 10,000")
    XCTAssertEqual(p.fraction, 0.642, accuracy: 0.0001)
  }

  func testProteinShowsGramsToGo() {
    let p = MetricKind.protein.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.label, "PROTEIN")
    XCTAssertEqual(p.heroText, "88")
    XCTAssertEqual(p.caption, "72G TO GO")
    XCTAssertEqual(p.deepLink, "mobile:///")
  }

  func testProteinMetTargetSaysSo() {
    let met = NutritionSnapshot(
      date: "2026-08-12", kcalConsumed: 1271, kcalTarget: 2451,
      proteinConsumed: 170, proteinTarget: 160, carbsConsumed: 110, carbsTarget: 260,
      fatConsumed: 57, fatTarget: 80, stepGoal: 10000
    )
    XCTAssertEqual(MetricKind.protein.present(snapshot: met, steps: nil).caption, "TARGET MET")
  }

  // A zero target must not divide by zero or produce NaN in the dial.
  func testZeroTargetProducesZeroFractionNotNaN() {
    let zero = NutritionSnapshot(
      date: "2026-08-12", kcalConsumed: 100, kcalTarget: 0,
      proteinConsumed: 0, proteinTarget: 0, carbsConsumed: 0, carbsTarget: 0,
      fatConsumed: 0, fatTarget: 0, stepGoal: 0
    )
    XCTAssertEqual(MetricKind.reserve.present(snapshot: zero, steps: nil).fraction, 0)
    XCTAssertEqual(MetricKind.steps.present(snapshot: zero, steps: 500).fraction, 0)
  }

  func testGroupedFormattingIsLocaleIndependent() {
    XCTAssertEqual(Format.grouped(1180), "1,180")
    XCTAssertEqual(Format.grouped(0), "0")
    XCTAssertEqual(Format.grouped(1234567), "1,234,567")
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: FAIL — "cannot find 'MetricKind' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/targets/kora-widgets/MetricKind.swift`:

```swift
import Foundation

// Pure metric model. Foundation ONLY — this file is symlinked into the
// widget-core-tests SPM package so `swift test` runs the exact code that
// ships, and importing SwiftUI/WidgetKit/AppIntents here would break the
// macOS test build.

enum Format {
  // en_US_POSIX, not the device locale: the widget's numerals are a fixed
  // design element and tests must not depend on where the machine is.
  private static let grouping: NumberFormatter = {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.usesGroupingSeparator = true
    return f
  }()

  static func grouped(_ value: Int) -> String {
    grouping.string(from: NSNumber(value: value)) ?? "\(value)"
  }
}

struct MetricPresentation: Equatable, Sendable {
  let label: String
  let heroText: String
  let caption: String
  /// 0...n, where 1.0 is the target. Values above 1 mean over target.
  let fraction: Double
  let isOverTarget: Bool
  let deepLink: String

  init(label: String, heroText: String, caption: String,
              fraction: Double, isOverTarget: Bool, deepLink: String) {
    self.label = label
    self.heroText = heroText
    self.caption = caption
    self.fraction = fraction
    self.isOverTarget = isOverTarget
    self.deepLink = deepLink
  }
}

enum MetricKind: String, CaseIterable, Sendable {
  case reserve
  case steps
  case protein

  /// `steps` is the RESOLVED step count: nil means unknown (see StepReading),
  /// and is rendered "—". It is deliberately not defaulted, so no caller can
  /// forget it and silently get a zero.
  func present(snapshot: NutritionSnapshot, steps: Int?) -> MetricPresentation {
    switch self {
    case .reserve:
      let left = Int((snapshot.kcalTarget - snapshot.kcalConsumed).rounded())
      let over = left < 0
      return MetricPresentation(
        label: "RESERVE",
        heroText: Format.grouped(abs(left)),
        caption: over ? "KCAL OVER" : "KCAL LEFT",
        fraction: Self.ratio(snapshot.kcalConsumed, snapshot.kcalTarget),
        isOverTarget: over,
        deepLink: "mobile:///"
      )

    case .steps:
      let goal = snapshot.stepGoal
      guard let steps else {
        return MetricPresentation(
          label: "STEPS", heroText: "—", caption: "OF \(Format.grouped(Int(goal)))",
          fraction: 0, isOverTarget: false, deepLink: "mobile:///progress"
        )
      }
      return MetricPresentation(
        label: "STEPS",
        heroText: Format.grouped(steps),
        caption: "OF \(Format.grouped(Int(goal)))",
        fraction: Self.ratio(Double(steps), goal),
        isOverTarget: goal > 0 && Double(steps) > goal,
        deepLink: "mobile:///progress"
      )

    case .protein:
      let consumed = Int(snapshot.proteinConsumed.rounded())
      let target = Int(snapshot.proteinTarget.rounded())
      let toGo = target - consumed
      return MetricPresentation(
        label: "PROTEIN",
        heroText: Format.grouped(consumed),
        caption: toGo > 0 ? "\(Format.grouped(toGo))G TO GO" : "TARGET MET",
        fraction: Self.ratio(snapshot.proteinConsumed, snapshot.proteinTarget),
        isOverTarget: target > 0 && consumed > target,
        deepLink: "mobile:///"
      )
    }
  }

  // A zero or negative target cannot produce a fraction — returning 0 keeps
  // NaN and infinity out of the dial geometry rather than letting SwiftUI
  // render a garbage angle.
  private static func ratio(_ value: Double, _ target: Double) -> Double {
    guard target > 0, value.isFinite else { return 0 }
    return max(value / target, 0)
  }
}
```

Create the symlink:

```bash
cd apps/mobile/widget-core-tests/Sources/KoraWidgetCore
ln -s ../../../targets/kora-widgets/MetricKind.swift MetricKind.swift
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 15 tests (6 existing + 9 new), 0 failures.

- [ ] **Step 5: Verify the symlink points at the shipping file**

Run: `ls -l apps/mobile/widget-core-tests/Sources/KoraWidgetCore/MetricKind.swift`
Expected: `MetricKind.swift -> ../../../targets/kora-widgets/MetricKind.swift`

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/targets/kora-widgets/MetricKind.swift \
        apps/mobile/widget-core-tests/Sources/KoraWidgetCore/MetricKind.swift \
        apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/MetricKindTests.swift
git commit -m "feat(widgets): add the pure metric model for the configurable widget"
```

---

### Task 2: Unknown-vs-zero step resolution

The bug that pulled the steps widget from the bundle, isolated into one pure function with no HealthKit dependency.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/StepReading.swift`
- Create (symlink): `apps/mobile/widget-core-tests/Sources/KoraWidgetCore/StepReading.swift`
- Create: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/StepReadingTests.swift`

**Interfaces:**
- Produces: `StepReading.resolve(todaySum:probeFoundSamples:) -> Int?`. Task 4 (`HealthReader`) is its only caller.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/StepReadingTests.swift`:

```swift
import XCTest
@testable import KoraWidgetCore

final class StepReadingTests: XCTestCase {
  func testPresentSumIsTheAnswer() {
    XCTAssertEqual(StepReading.resolve(todaySum: 6420, probeFoundSamples: false), 6420)
  }

  // A sum that is PRESENT and zero is a measured fact, not an absence.
  func testPresentZeroIsARealZero() {
    XCTAssertEqual(StepReading.resolve(todaySum: 0, probeFoundSamples: false), 0)
  }

  // Absent today + samples in the last 7 days = the user simply has not
  // walked yet. That is a genuine zero.
  func testAbsentSumWithProbeSamplesIsZero() {
    XCTAssertEqual(StepReading.resolve(todaySum: nil, probeFoundSamples: true), 0)
  }

  // Absent today + nothing in 7 days = we cannot read Health at all.
  // THE bug: this must be nil, never 0.
  func testAbsentSumWithEmptyProbeIsUnknown() {
    XCTAssertNil(StepReading.resolve(todaySum: nil, probeFoundSamples: false))
  }

  func testNonFiniteSumIsTreatedAsAbsent() {
    XCTAssertNil(StepReading.resolve(todaySum: Double.nan, probeFoundSamples: false))
    XCTAssertNil(StepReading.resolve(todaySum: Double.infinity, probeFoundSamples: false))
    XCTAssertEqual(StepReading.resolve(todaySum: Double.nan, probeFoundSamples: true), 0)
  }

  func testFractionalSumRounds() {
    XCTAssertEqual(StepReading.resolve(todaySum: 6420.6, probeFoundSamples: false), 6421)
  }

  // HealthKit should never hand back a negative sum, but a negative rendered
  // on the home screen would be worse than clamping.
  func testNegativeSumClampsToZero() {
    XCTAssertEqual(StepReading.resolve(todaySum: -5, probeFoundSamples: false), 0)
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: FAIL — "cannot find 'StepReading' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/targets/kora-widgets/StepReading.swift`:

```swift
import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

/// Resolves HealthKit's ambiguity about today's step count.
///
/// iOS deliberately will not disclose whether an app holds READ permission:
/// `authorizationStatus(for:)` reports `.notDetermined` for a denied read, by
/// design. So "denied" and "hasn't walked yet" both surface as an absent sum
/// and cannot be told apart from a single query.
///
/// The previous implementation resolved that by returning 0, which put a
/// confident zero on the home screen on the strength of no data — the reason
/// the steps widget was pulled from the bundle on 2026-08-12.
///
/// The probe is what disambiguates: if ANY step sample exists in the last 7
/// days, reads work and today's absence is a real zero. If the window is
/// empty too, we cannot read Health and the honest answer is "unknown".
enum StepReading {
  /// - Parameters:
  ///   - todaySum: `sumQuantity()` for today, or nil when absent.
  ///   - probeFoundSamples: whether the 7-day probe found any sample at all.
  /// - Returns: the step count, or nil for unknown. Callers MUST render nil
  ///   as "—" and never as 0.
  static func resolve(todaySum: Double?, probeFoundSamples: Bool) -> Int? {
    if let sum = todaySum, sum.isFinite {
      return max(Int(sum.rounded()), 0)
    }
    return probeFoundSamples ? 0 : nil
  }
}
```

Create the symlink:

```bash
cd apps/mobile/widget-core-tests/Sources/KoraWidgetCore
ln -s ../../../targets/kora-widgets/StepReading.swift StepReading.swift
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 22 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets/kora-widgets/StepReading.swift \
        apps/mobile/widget-core-tests/Sources/KoraWidgetCore/StepReading.swift \
        apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/StepReadingTests.swift
git commit -m "feat(widgets): resolve unknown step reads as unknown instead of zero"
```

---

### Task 3: Dial geometry

The tick positions, lit boundary and redline classing, shared by every family that draws a dial. Pure so the geometry can be pinned the way `BrandMark`'s is.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/DialGeometry.swift`
- Create (symlink): `apps/mobile/widget-core-tests/Sources/KoraWidgetCore/DialGeometry.swift`
- Create: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/DialGeometryTests.swift`

**Interfaces:**
- Produces: `DialGeometry.tickCount`, `.isMajor(index:)`, `.angleDegrees(index:)`, `.isLit(index:fraction:)`, `.isRedline(index:)`, `.needleAngleDegrees(fraction:)`. Task 6 (`DialView`) is the only consumer.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/DialGeometryTests.swift`:

```swift
import XCTest
@testable import KoraWidgetCore

final class DialGeometryTests: XCTestCase {
  func testSweepsTheSpecdArc() {
    XCTAssertEqual(DialGeometry.tickCount, 33)
    XCTAssertEqual(DialGeometry.angleDegrees(index: 0), -205, accuracy: 0.001)
    XCTAssertEqual(DialGeometry.angleDegrees(index: 32), 25, accuracy: 0.001)
  }

  func testEveryFourthTickIsMajor() {
    XCTAssertTrue(DialGeometry.isMajor(index: 0))
    XCTAssertTrue(DialGeometry.isMajor(index: 4))
    XCTAssertFalse(DialGeometry.isMajor(index: 1))
    XCTAssertTrue(DialGeometry.isMajor(index: 32))
  }

  func testLitUpToTheFractionAndDimPastIt() {
    // fraction 0.5 lights the first half of the arc inclusive.
    XCTAssertTrue(DialGeometry.isLit(index: 0, fraction: 0.5))
    XCTAssertTrue(DialGeometry.isLit(index: 16, fraction: 0.5))
    XCTAssertFalse(DialGeometry.isLit(index: 17, fraction: 0.5))
    XCTAssertFalse(DialGeometry.isLit(index: 32, fraction: 0.5))
  }

  func testZeroFractionLightsOnlyTheFirstTick() {
    XCTAssertTrue(DialGeometry.isLit(index: 0, fraction: 0))
    XCTAssertFalse(DialGeometry.isLit(index: 1, fraction: 0))
  }

  func testOverTargetFractionLightsEverythingAndDoesNotOverflow() {
    XCTAssertTrue(DialGeometry.isLit(index: 32, fraction: 1.4))
    XCTAssertEqual(DialGeometry.needleAngleDegrees(fraction: 1.4), 25, accuracy: 0.001)
  }

  // Redline is the last 10% of the arc, per the design spec.
  func testRedlineIsTheLastTenPercentOfTheArc() {
    XCTAssertFalse(DialGeometry.isRedline(index: 28))
    XCTAssertTrue(DialGeometry.isRedline(index: 30))
    XCTAssertTrue(DialGeometry.isRedline(index: 32))
  }

  func testNeedleTracksTheFraction() {
    XCTAssertEqual(DialGeometry.needleAngleDegrees(fraction: 0), -205, accuracy: 0.001)
    XCTAssertEqual(DialGeometry.needleAngleDegrees(fraction: 1), 25, accuracy: 0.001)
    XCTAssertEqual(DialGeometry.needleAngleDegrees(fraction: 0.5), -90, accuracy: 0.001)
  }

  func testNonFiniteFractionIsTreatedAsZero() {
    XCTAssertEqual(DialGeometry.needleAngleDegrees(fraction: .nan), -205, accuracy: 0.001)
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: FAIL — "cannot find 'DialGeometry' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/targets/kora-widgets/DialGeometry.swift`:

```swift
import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

/// The dial's tick geometry, matching the app's GaugeDial and BrandMark:
/// a 230° arc swept from -205° to +25°, ticks lit up to value/target, the
/// last 10% classed as redline.
enum DialGeometry {
  static let tickCount = 33
  static let startDegrees = -205.0
  static let endDegrees = 25.0
  private static let redlineStartFraction = 0.9

  static func isMajor(index: Int) -> Bool { index % 4 == 0 }

  static func angleDegrees(index: Int) -> Double {
    startDegrees + (endDegrees - startDegrees) * progress(index)
  }

  static func isLit(index: Int, fraction: Double) -> Bool {
    progress(index) <= clamped(fraction)
  }

  static func isRedline(index: Int) -> Bool {
    progress(index) >= redlineStartFraction
  }

  static func needleAngleDegrees(fraction: Double) -> Double {
    startDegrees + (endDegrees - startDegrees) * clamped(fraction)
  }

  private static func progress(_ index: Int) -> Double {
    guard tickCount > 1 else { return 0 }
    return Double(index) / Double(tickCount - 1)
  }

  // Over-target values pin the needle at full deflection rather than swinging
  // it past the scale — a real instrument's needle stops at the stop.
  private static func clamped(_ fraction: Double) -> Double {
    guard fraction.isFinite else { return 0 }
    return min(max(fraction, 0), 1)
  }
}
```

Create the symlink:

```bash
cd apps/mobile/widget-core-tests/Sources/KoraWidgetCore
ln -s ../../../targets/kora-widgets/DialGeometry.swift DialGeometry.swift
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 30 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets/kora-widgets/DialGeometry.swift \
        apps/mobile/widget-core-tests/Sources/KoraWidgetCore/DialGeometry.swift \
        apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/DialGeometryTests.swift
git commit -m "feat(widgets): add pinned dial geometry for the widget gauge"
```

---

### Task 4: HealthKit reader

A thin shell over HealthKit that runs the two queries and hands the answers to `StepReading.resolve`. It contains no decisions of its own, so there is nothing here that unit tests could catch — correctness is established by Task 3's tests plus device gate 2.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/HealthReader.swift`

**Interfaces:**
- Consumes: `StepReading.resolve(todaySum:probeFoundSamples:)` from Task 2.
- Produces: `HealthReader.todaySteps() async -> Int?` and `HealthReader.last7Days() async -> [DayStep]`, where `DayStep` is `(date: Date, steps: Int?)`. Tasks 7 and 10 consume both.

- [ ] **Step 1: Write the implementation**

Create `apps/mobile/targets/kora-widgets/HealthReader.swift`:

```swift
import Foundation
import HealthKit

// Deliberately decision-free: every judgement about what an absent sum MEANS
// lives in StepReading (pure, unit-tested). This file only runs queries.
// A widget extension CANNOT call requestAuthorization — only the app can —
// so this either reads or it does not.

struct DayStep: Identifiable, Sendable {
  let date: Date
  /// nil = unknown for that day. Rendered as a gap, never a zero-height bar.
  let steps: Int?
  var id: Date { date }
}

enum HealthReader {
  static let store = HKHealthStore()
  private static let probeDays = 7

  /// Today's steps, or nil when unknown. See StepReading for why the probe exists.
  static func todaySteps() async -> Int? {
    guard HKHealthStore.isHealthDataAvailable() else { return nil }
    let start = Calendar.current.startOfDay(for: Date())
    let todaySum = await cumulativeSum(from: start, to: Date())
    if let todaySum { return StepReading.resolve(todaySum: todaySum, probeFoundSamples: true) }

    let probeStart = Calendar.current.date(byAdding: .day, value: -probeDays, to: start) ?? start
    let probeSum = await cumulativeSum(from: probeStart, to: Date())
    return StepReading.resolve(todaySum: nil, probeFoundSamples: probeSum != nil)
  }

  /// The last 7 days including today, oldest first, for the medium family's history strip.
  static func last7Days() async -> [DayStep] {
    guard HKHealthStore.isHealthDataAvailable() else { return [] }
    let cal = Calendar.current
    let todayStart = cal.startOfDay(for: Date())
    guard let anchor = cal.date(byAdding: .day, value: -(probeDays - 1), to: todayStart) else { return [] }

    let collection = await statisticsCollection(anchor: anchor)
    guard let collection else { return [] }

    var out: [DayStep] = []
    for offset in 0..<probeDays {
      guard let day = cal.date(byAdding: .day, value: offset, to: anchor) else { continue }
      let stats = collection.statistics(for: day)
      let sum = stats?.sumQuantity()?.doubleValue(for: .count())
      // Absent here means "no samples for that day". Within a window we KNOW
      // is readable (the collection query succeeded), that is a real zero.
      out.append(DayStep(date: day, steps: sum.map { max(Int($0.rounded()), 0) } ?? 0))
    }
    return out
  }

  private static func cumulativeSum(from start: Date, to end: Date) async -> Double? {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])
    return await withCheckedContinuation { continuation in
      let query = HKStatisticsQuery(
        quantityType: HKQuantityType(.stepCount),
        quantitySamplePredicate: predicate,
        options: .cumulativeSum
      ) { _, statistics, _ in
        // An error and an absent sum are the same fact here: nothing readable.
        // StepReading decides what that MEANS.
        continuation.resume(returning: statistics?.sumQuantity()?.doubleValue(for: .count()))
      }
      store.execute(query)
    }
  }

  private static func statisticsCollection(anchor: Date) async -> HKStatisticsCollection? {
    await withCheckedContinuation { continuation in
      let query = HKStatisticsCollectionQuery(
        quantityType: HKQuantityType(.stepCount),
        quantitySamplePredicate: nil,
        options: .cumulativeSum,
        anchorDate: anchor,
        intervalComponents: DateComponents(day: 1)
      )
      query.initialResultsHandler = { _, collection, _ in
        continuation.resume(returning: collection)
      }
      store.execute(query)
    }
  }
}
```

- [ ] **Step 2: Verify it compiles against the SPM package boundary**

`HealthReader` imports HealthKit, so it must NOT be symlinked into `widget-core-tests`.

Run: `ls apps/mobile/widget-core-tests/Sources/KoraWidgetCore/`
Expected: `Snapshot.swift`, `MetricKind.swift`, `StepReading.swift`, `DialGeometry.swift` — and **no** `HealthReader.swift`.

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 30 tests, unchanged. If this fails with a HealthKit import error, a symlink was created by mistake; remove it.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/targets/kora-widgets/HealthReader.swift
git commit -m "feat(widgets): add a decision-free HealthKit reader for widget step counts"
```

---

### Task 5: Configuration intent and iOS 17 target

Introduces the metric picker and raises only the extension's deployment target.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/MetricIntent.swift`
- Modify: `apps/mobile/targets/kora-widgets/expo-target.config.js`

**Interfaces:**
- Consumes: `MetricKind` from Task 1.
- Produces: `MetricIntent` (a `WidgetConfigurationIntent` with a `metric: MetricChoice` parameter) and `MetricChoice` (`AppEnum`), plus `MetricChoice.kind -> MetricKind`. Task 10 consumes both.

- [ ] **Step 1: Write the implementation**

Create `apps/mobile/targets/kora-widgets/MetricIntent.swift`:

```swift
import AppIntents
import WidgetKit

// AppIntents requires iOS 17, which is why the extension's deployment target
// is raised in expo-target.config.js while the app stays at 16.4.
//
// MetricChoice is a separate type from MetricKind on purpose: MetricKind is
// pure Foundation so it can be unit-tested by the SPM package, and importing
// AppIntents into it would break `swift test` on macOS.

enum MetricChoice: String, AppEnum {
  case reserve
  case steps
  case protein

  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Metric" }

  static var caseDisplayRepresentations: [MetricChoice: DisplayRepresentation] = [
    .reserve: DisplayRepresentation(title: "Energy reserve", subtitle: "Calories left today"),
    .steps: DisplayRepresentation(title: "Steps", subtitle: "Steps against your goal"),
    .protein: DisplayRepresentation(title: "Protein", subtitle: "Protein against your target"),
  ]

  var kind: MetricKind {
    switch self {
    case .reserve: return .reserve
    case .steps: return .steps
    case .protein: return .protein
    }
  }
}

struct MetricIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource { "Kora" }
  static var description: IntentDescription { "Choose what this widget shows." }

  @Parameter(title: "Show", default: .reserve)
  var metric: MetricChoice

  init() {}

  init(metric: MetricChoice) {
    self.metric = metric
  }
}
```

- [ ] **Step 2: Raise the extension's deployment target**

Modify `apps/mobile/targets/kora-widgets/expo-target.config.js`. Inside the returned object, immediately after the `name: "korawidgets",` line, add:

```js
    // AppIntentConfiguration (the metric picker) requires iOS 17. This raises
    // the EXTENSION only — the app stays at 16.4, so iOS 16 users keep the app
    // and simply see no Kora widgets in the gallery. @bacons/apple-targets maps
    // this to IPHONEOS_DEPLOYMENT_TARGET on the target's build configuration.
    deploymentTarget: "17.0",
```

Then add `"AppIntents"` to the existing `frameworks` array so it reads:

```js
    frameworks: ["SwiftUI", "WidgetKit", "HealthKit", "AppIntents"],
```

Leave `name: "korawidgets"` and the app-group guard exactly as they are.

- [ ] **Step 3: Verify the config still guards the App Group and keeps the target name**

Run:

```bash
cd apps/mobile && node -e "
const fn = require('./targets/kora-widgets/expo-target.config.js');
const cfg = fn({ ios: { entitlements: { 'com.apple.security.application-groups': ['group.com.tesserix.kora'] } } });
console.log(JSON.stringify(cfg, null, 2));
"
```

Expected: `name` is `korawidgets`, `deploymentTarget` is `17.0`, `frameworks` includes `AppIntents`, and entitlements carry both the app group and HealthKit.

Then confirm it still throws without the app group:

```bash
cd apps/mobile && node -e "
const fn = require('./targets/kora-widgets/expo-target.config.js');
try { fn({ ios: {} }); console.log('FAIL: did not throw'); }
catch (e) { console.log('OK threw:', e.message.slice(0, 60)); }
"
```

Expected: `OK threw: ...`

- [ ] **Step 4: Verify the app's own deployment target is untouched**

Run: `grep -c "IPHONEOS_DEPLOYMENT_TARGET = 16.4" apps/mobile/ios/Kora.xcodeproj/project.pbxproj`
Expected: a non-zero count. The app target must remain 16.4; only the widget extension moves to 17.

Note: `ios/` is gitignored (CNG). Do not commit it.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets/kora-widgets/MetricIntent.swift \
        apps/mobile/targets/kora-widgets/expo-target.config.js
git commit -m "feat(widgets): add the metric configuration intent and raise the extension to iOS 17"
```

---

### Task 6: Dial view and the small family

**Files:**
- Create: `apps/mobile/targets/kora-widgets/DialView.swift`
- Create: `apps/mobile/targets/kora-widgets/WidgetTheme.swift`
- Create: `apps/mobile/targets/kora-widgets/SmallView.swift`

**Interfaces:**
- Consumes: `DialGeometry` (Task 3), `MetricPresentation` (Task 1).
- Produces: `WidgetTheme` (colour constants), `DialView(fraction:isOverTarget:)`, `SmallView(presentation:)`. Tasks 7, 8 and 10 consume all three.

- [ ] **Step 1: Write the theme**

Create `apps/mobile/targets/kora-widgets/WidgetTheme.swift`:

```swift
import SwiftUI

// The widget keeps the SYSTEM containerBackground so iOS 18 tinting and
// vibrancy keep working; identity is carried by the CONTENT — tick dial,
// accent needle, mono tabular numerals, engraved labels.
//
// Ink and mut therefore use the system's semantic colours rather than Kora's
// bg/ink tokens: on a tinted or vibrant home screen, hardcoded palette values
// stop adapting and go illegible.
enum WidgetTheme {
  /// THE accent. Needle, hub, redline, goal-hit bars. Nothing else.
  static let accent = Color(red: 1.0, green: 74.0 / 255.0, blue: 0.0)
  static let ink = Color.primary
  static let mut = Color.secondary
  static let tick = Color.primary.opacity(0.18)

  static func engraved(_ size: CGFloat = 9) -> Font {
    .system(size: size, weight: .medium, design: .monospaced)
  }

  static func numeral(_ size: CGFloat) -> Font {
    .system(size: size, weight: .bold, design: .monospaced)
  }
}
```

- [ ] **Step 2: Write the dial view**

Create `apps/mobile/targets/kora-widgets/DialView.swift`:

```swift
import SwiftUI

/// The tick gauge. Geometry comes entirely from DialGeometry (pure, tested);
/// this view only draws it.
struct DialView: View {
  let fraction: Double
  let isOverTarget: Bool

  var body: some View {
    GeometryReader { geo in
      let side = min(geo.size.width, geo.size.height)
      let radius = side / 2
      let center = CGPoint(x: geo.size.width / 2, y: side / 2)

      ZStack {
        ForEach(0..<DialGeometry.tickCount, id: \.self) { index in
          tick(index: index, center: center, radius: radius)
        }
        needle(center: center, radius: radius)
      }
    }
  }

  private func tick(index: Int, center: CGPoint, radius: CGFloat) -> some View {
    let major = DialGeometry.isMajor(index: index)
    let lit = DialGeometry.isLit(index: index, fraction: fraction)
    let redline = DialGeometry.isRedline(index: index)
    let length: CGFloat = major ? radius * 0.21 : radius * 0.13
    let angle = Angle(degrees: DialGeometry.angleDegrees(index: index))

    // Redline ticks tint accent only once the value has actually reached
    // them — an unlit redline is still just an unlit tick.
    let colour: Color = lit ? (redline && isOverTarget ? WidgetTheme.accent : WidgetTheme.ink)
                            : WidgetTheme.tick

    return Path { path in
      path.move(to: point(center: center, radius: radius, angle: angle))
      path.addLine(to: point(center: center, radius: radius - length, angle: angle))
    }
    .stroke(colour, style: StrokeStyle(lineWidth: major ? radius * 0.05 : radius * 0.035, lineCap: .round))
  }

  private func needle(center: CGPoint, radius: CGFloat) -> some View {
    let angle = Angle(degrees: DialGeometry.needleAngleDegrees(fraction: fraction))
    return ZStack {
      Path { path in
        path.move(to: center)
        path.addLine(to: point(center: center, radius: radius * 0.68, angle: angle))
      }
      .stroke(WidgetTheme.accent, style: StrokeStyle(lineWidth: radius * 0.062, lineCap: .round))

      Circle()
        .fill(WidgetTheme.accent)
        .frame(width: radius * 0.16, height: radius * 0.16)
        .position(center)
    }
  }

  private func point(center: CGPoint, radius: CGFloat, angle: Angle) -> CGPoint {
    CGPoint(x: center.x + radius * cos(angle.radians),
            y: center.y + radius * sin(angle.radians))
  }
}
```

- [ ] **Step 3: Write the small family view**

Create `apps/mobile/targets/kora-widgets/SmallView.swift`:

```swift
import SwiftUI

struct SmallView: View {
  let presentation: MetricPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(presentation.label)
        .font(WidgetTheme.engraved())
        .kerning(1.8)
        .foregroundStyle(WidgetTheme.mut)

      ZStack {
        DialView(fraction: presentation.fraction, isOverTarget: presentation.isOverTarget)
        VStack(spacing: 3) {
          Text(presentation.heroText)
            .font(WidgetTheme.numeral(26))
            .monospacedDigit()
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .foregroundStyle(WidgetTheme.ink)
          Text(presentation.caption)
            .font(WidgetTheme.engraved(8))
            .kerning(1.4)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(WidgetTheme.mut)
        }
        .padding(.top, 14)
      }
      .frame(maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
```

- [ ] **Step 4: Verify the SPM package is unaffected**

These files import SwiftUI and must not be symlinked.

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 30 tests, unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets/kora-widgets/WidgetTheme.swift \
        apps/mobile/targets/kora-widgets/DialView.swift \
        apps/mobile/targets/kora-widgets/SmallView.swift
git commit -m "feat(widgets): add the instrument dial and small widget family"
```

---

### Task 7: Medium family

**Files:**
- Create: `apps/mobile/targets/kora-widgets/MediumView.swift`
- Create: `apps/mobile/targets/kora-widgets/TrackView.swift`

**Interfaces:**
- Consumes: `DialView`, `WidgetTheme` (Task 6), `MetricPresentation`, `MetricKind` (Task 1), `NutritionSnapshot`, `DayStep` (Task 4).
- Produces: `TrackView(label:fraction:detail:)`, `MediumView(kind:presentation:snapshot:history:)`. Task 10 consumes `MediumView`.

- [ ] **Step 1: Write the track view**

Create `apps/mobile/targets/kora-widgets/TrackView.swift`:

```swift
import SwiftUI

/// An engraved label over a recessed progress track. The widget's equivalent
/// of the app's macro rows.
struct TrackView: View {
  let label: String
  let fraction: Double
  let detail: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(WidgetTheme.tick)
          Capsule()
            .fill(fraction > 1 ? WidgetTheme.accent : WidgetTheme.ink.opacity(0.85))
            .frame(width: geo.size.width * min(max(fraction, 0), 1))
        }
      }
      .frame(height: 5)

      if let detail {
        Text(detail)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .monospacedDigit()
          .foregroundStyle(WidgetTheme.ink)
      }
    }
  }
}
```

- [ ] **Step 2: Write the medium view**

Create `apps/mobile/targets/kora-widgets/MediumView.swift`:

```swift
import SwiftUI

/// Medium DEEPENS the chosen metric rather than broadening to all of them:
/// someone who configured this widget to Steps wanted steps, and gets more of it.
struct MediumView: View {
  let kind: MetricKind
  let presentation: MetricPresentation
  let snapshot: NutritionSnapshot
  let history: [DayStep]

  var body: some View {
    HStack(spacing: 14) {
      SmallView(presentation: presentation)
        .frame(width: 118)

      expansion
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder private var expansion: some View {
    switch kind {
    case .reserve, .protein:
      macroExpansion
    case .steps:
      historyExpansion
    }
  }

  private var macroExpansion: some View {
    VStack(alignment: .leading, spacing: 10) {
      TrackView(
        label: "PROTEIN",
        fraction: ratio(snapshot.proteinConsumed, snapshot.proteinTarget),
        detail: "\(Int(snapshot.proteinConsumed)) / \(Int(snapshot.proteinTarget)) g"
      )
      HStack(spacing: 12) {
        TrackView(label: "CARBS", fraction: ratio(snapshot.carbsConsumed, snapshot.carbsTarget), detail: nil)
        TrackView(label: "FAT", fraction: ratio(snapshot.fatConsumed, snapshot.fatTarget), detail: nil)
      }
    }
  }

  private var historyExpansion: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text("LAST 7 DAYS")
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)

      HStack(alignment: .bottom, spacing: 4) {
        ForEach(history) { day in
          bar(for: day)
        }
      }
      .frame(height: 34)

      Text(summaryLine)
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(WidgetTheme.mut)
    }
  }

  private func bar(for day: DayStep) -> some View {
    let goal = snapshot.stepGoal
    // An unknown day is a GAP, not a zero-height bar — same invariant as the
    // hero numeral. A flat bar would read as "you walked nothing".
    let known = day.steps
    let fraction = (goal > 0 && known != nil) ? min(Double(known!) / goal, 1) : 0
    let hit = known != nil && goal > 0 && Double(known!) >= goal

    return RoundedRectangle(cornerRadius: 2)
      .fill(known == nil ? WidgetTheme.tick : (hit ? WidgetTheme.accent : WidgetTheme.ink.opacity(0.55)))
      .frame(maxWidth: .infinity)
      .frame(height: known == nil ? 3 : max(4, 34 * fraction))
  }

  private var summaryLine: String {
    let known = history.compactMap(\.steps)
    guard !known.isEmpty else { return "no history" }
    let avg = known.reduce(0, +) / known.count
    let hits = known.filter { snapshot.stepGoal > 0 && Double($0) >= snapshot.stepGoal }.count
    return "avg \(Format.grouped(avg)) · \(hits) goal days"
  }

  private func ratio(_ value: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return value / target
  }
}
```

- [ ] **Step 3: Verify the SPM package is unaffected**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 30 tests, unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/targets/kora-widgets/TrackView.swift \
        apps/mobile/targets/kora-widgets/MediumView.swift
git commit -m "feat(widgets): add the medium family deepening the chosen metric"
```

---

### Task 8: Large family and accessories

**Files:**
- Create: `apps/mobile/targets/kora-widgets/LargeView.swift`
- Create: `apps/mobile/targets/kora-widgets/AccessoryViews.swift`

**Interfaces:**
- Consumes: `DialView`, `TrackView`, `WidgetTheme`, `MetricPresentation`, `NutritionSnapshot`.
- Produces: `LargeView(presentation:snapshot:steps:)`, `AccessoryRectangularView(presentation:)`, `AccessoryInlineView(presentation:)`. Task 10 consumes all three.

- [ ] **Step 1: Write the large view**

Create `apps/mobile/targets/kora-widgets/LargeView.swift`:

```swift
import SwiftUI

/// Large is ALWAYS the whole day, whatever metric is configured — it is the
/// only family with room for secondary figures to be legible.
struct LargeView: View {
  let presentation: MetricPresentation
  let snapshot: NutritionSnapshot
  let steps: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 16) {
        SmallView(presentation: presentation)
          .frame(width: 132)

        VStack(alignment: .leading, spacing: 10) {
          TrackView(
            label: "PROTEIN",
            fraction: ratio(snapshot.proteinConsumed, snapshot.proteinTarget),
            detail: "\(Int(snapshot.proteinConsumed)) / \(Int(snapshot.proteinTarget)) g"
          )
          HStack(spacing: 12) {
            TrackView(label: "CARBS", fraction: ratio(snapshot.carbsConsumed, snapshot.carbsTarget), detail: nil)
            TrackView(label: "FAT", fraction: ratio(snapshot.fatConsumed, snapshot.fatTarget), detail: nil)
          }
          HStack(spacing: 18) {
            figure(label: "STEPS", value: steps.map(Format.grouped) ?? "—")
            figure(label: "GOAL", value: Format.grouped(Int(snapshot.stepGoal)))
          }
        }
      }

      Divider().overlay(WidgetTheme.tick)

      Text("LOGGED TODAY")
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)

      // The snapshot carries totals, not individual meals, so this family
      // shows the day's macro totals as its detail rather than a meal list.
      // Adding meals would require widening the wire format on both sides —
      // out of scope for this plan (see spec: the wire format does not change).
      HStack(spacing: 18) {
        figure(label: "EATEN", value: Format.grouped(Int(snapshot.kcalConsumed)))
        figure(label: "BUDGET", value: Format.grouped(Int(snapshot.kcalTarget)))
      }

      Spacer(minLength: 0)
    }
  }

  private func figure(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label)
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)
      Text(value)
        .font(.system(size: 13, weight: .semibold, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(WidgetTheme.ink)
    }
  }

  private func ratio(_ value: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return value / target
  }
}
```

- [ ] **Step 2: Write the accessory views**

Create `apps/mobile/targets/kora-widgets/AccessoryViews.swift`:

```swift
import SwiftUI

// iOS renders Lock Screen accessories as a flat white mask, so colour and the
// accent do not survive here — these are deliberately typographic. There is no
// accessoryCircular: the 33-tick dial turns to mush at 64pt under the mask.

struct AccessoryRectangularView: View {
  let presentation: MetricPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(presentation.label)
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .kerning(1.2)
      Text(presentation.heroText)
        .font(.system(size: 22, weight: .bold, design: .monospaced))
        .monospacedDigit()
        .minimumScaleFactor(0.7)
        .lineLimit(1)
      ProgressView(value: min(max(presentation.fraction, 0), 1))
        .progressViewStyle(.linear)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct AccessoryInlineView: View {
  let presentation: MetricPresentation

  var body: some View {
    // Inline gets ONE line beside the clock, so the label is dropped and the
    // caption carries the context: "6,420 of 10,000".
    Text("\(presentation.heroText) \(presentation.caption.lowercased())")
  }
}
```

- [ ] **Step 3: Verify the SPM package is unaffected**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 30 tests, unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/targets/kora-widgets/LargeView.swift \
        apps/mobile/targets/kora-widgets/AccessoryViews.swift
git commit -m "feat(widgets): add the large family and lock screen accessories"
```

---

### Task 9: Empty and stale states

The states that must never render a confident number, isolated so they can be read in one place.

**Files:**
- Create: `apps/mobile/targets/kora-widgets/EmptyStateView.swift`
- Create (symlink): `apps/mobile/widget-core-tests/Sources/KoraWidgetCore/EmptyStateCopy.swift`
- Create: `apps/mobile/targets/kora-widgets/EmptyStateCopy.swift`
- Create: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/EmptyStateCopyTests.swift`

**Interfaces:**
- Consumes: `MetricKind` (Task 1).
- Produces: `EmptyStateCopy.forMissingSnapshot(kind:) -> (title: String, detail: String)` and `EmptyStateView(title:detail:)`. Task 10 consumes both.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/EmptyStateCopyTests.swift`:

```swift
import XCTest
@testable import KoraWidgetCore

final class EmptyStateCopyTests: XCTestCase {
  func testEveryMetricHasItsOwnDetailCopy() {
    let details = MetricKind.allCases.map { EmptyStateCopy.forMissingSnapshot(kind: $0).detail }
    XCTAssertEqual(Set(details).count, MetricKind.allCases.count, "each metric needs distinct copy")
  }

  func testTitleAlwaysPointsAtTheApp() {
    for kind in MetricKind.allCases {
      XCTAssertEqual(EmptyStateCopy.forMissingSnapshot(kind: kind).title, "Open Kora")
    }
  }

  func testStepsCopyMentionsSteps() {
    XCTAssertEqual(EmptyStateCopy.forMissingSnapshot(kind: .steps).detail, "to see your steps")
  }

  // No empty state may render a number — that is the whole point of it.
  func testNoCopyContainsADigit() {
    for kind in MetricKind.allCases {
      let copy = EmptyStateCopy.forMissingSnapshot(kind: kind)
      XCTAssertNil(copy.title.rangeOfCharacter(from: .decimalDigits))
      XCTAssertNil(copy.detail.rangeOfCharacter(from: .decimalDigits))
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: FAIL — "cannot find 'EmptyStateCopy' in scope".

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/targets/kora-widgets/EmptyStateCopy.swift`:

```swift
import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

enum EmptyStateCopy {
  /// Copy for "no snapshot": signed out, or the app has never been opened
  /// since install. Also the sign-out privacy path (issue #135) — the previous
  /// user's figures must leave the home screen entirely.
  static func forMissingSnapshot(kind: MetricKind) -> (title: String, detail: String) {
    switch kind {
    case .reserve: return ("Open Kora", "to see today's calories")
    case .steps: return ("Open Kora", "to see your steps")
    case .protein: return ("Open Kora", "to see your protein")
    }
  }
}
```

Create the symlink:

```bash
cd apps/mobile/widget-core-tests/Sources/KoraWidgetCore
ln -s ../../../targets/kora-widgets/EmptyStateCopy.swift EmptyStateCopy.swift
```

Create `apps/mobile/targets/kora-widgets/EmptyStateView.swift`:

```swift
import SwiftUI

struct EmptyStateView: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(spacing: 4) {
      Text(title)
        .font(.headline)
        .foregroundStyle(WidgetTheme.ink)
      Text(detail)
        .font(.caption)
        .multilineTextAlignment(.center)
        .foregroundStyle(WidgetTheme.mut)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 34 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets/kora-widgets/EmptyStateCopy.swift \
        apps/mobile/targets/kora-widgets/EmptyStateView.swift \
        apps/mobile/widget-core-tests/Sources/KoraWidgetCore/EmptyStateCopy.swift \
        apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/EmptyStateCopyTests.swift
git commit -m "feat(widgets): add empty state copy that never renders a number"
```

---

### Task 10: Assemble KoraWidget and retire the old widgets

**Files:**
- Create: `apps/mobile/targets/kora-widgets/KoraWidget.swift`
- Modify: `apps/mobile/targets/kora-widgets/index.swift`
- Delete: `apps/mobile/targets/kora-widgets/NutritionWidget.swift`
- Delete: `apps/mobile/targets/kora-widgets/StepsWidget.swift`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: `KoraWidget`, the sole member of the widget bundle.

- [ ] **Step 1: Write the widget**

Create `apps/mobile/targets/kora-widgets/KoraWidget.swift`:

```swift
import AppIntents
import SwiftUI
import WidgetKit

struct KoraEntry: TimelineEntry {
  let date: Date
  let kind: MetricKind
  /// nil when there is no snapshot for TODAY — drives the empty state.
  let snapshot: NutritionSnapshot?
  /// nil = unknown. Only ever consulted for the steps metric.
  let steps: Int?
  let history: [DayStep]
}

struct KoraProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> KoraEntry {
    // Representative figures, never zeros: a gallery preview full of zeros
    // reads as a broken widget.
    KoraEntry(date: Date(), kind: .reserve, snapshot: Self.sample, steps: 6420, history: [])
  }

  func snapshot(for configuration: MetricIntent, in context: Context) async -> KoraEntry {
    await entry(for: configuration)
  }

  func timeline(for configuration: MetricIntent, in context: Context) async -> Timeline<KoraEntry> {
    let current = await entry(for: configuration)

    // 30 minutes, not 15: WidgetKit's daily budget is roughly 40-70 refreshes
    // and 15 minutes asks for 96, so iOS throttles and the widget ends up LESS
    // fresh than a smaller ask would be. Reserve and Protein also get a push
    // reload from the app on every snapshot write (WidgetBridgeModule), so
    // this cadence mainly has to catch the midnight rollover and step drift.
    let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
    return Timeline(entries: [current], policy: .after(next))
  }

  private func entry(for configuration: MetricIntent) async -> KoraEntry {
    let kind = configuration.metric.kind
    let snapshot = SnapshotStore.current()

    // No snapshot means no account context at all — do not touch HealthKit,
    // and do not render a step count belonging to nobody.
    guard snapshot != nil else {
      return KoraEntry(date: Date(), kind: kind, snapshot: nil, steps: nil, history: [])
    }

    guard kind == .steps else {
      return KoraEntry(date: Date(), kind: kind, snapshot: snapshot, steps: nil, history: [])
    }

    let steps = await HealthReader.todaySteps()
    let history = await HealthReader.last7Days()
    return KoraEntry(date: Date(), kind: kind, snapshot: snapshot, steps: steps, history: history)
  }

  private static let sample = NutritionSnapshot(
    date: SnapshotLogic.localDayString(Date(), timeZone: .current),
    kcalConsumed: 1271, kcalTarget: 2451,
    proteinConsumed: 88, proteinTarget: 160,
    carbsConsumed: 110, carbsTarget: 260,
    fatConsumed: 57, fatTarget: 80, stepGoal: 10000
  )
}

struct KoraWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: KoraEntry

  var body: some View {
    content
      .containerBackground(.fill.tertiary, for: .widget)
      .widgetURL(URL(string: link))
  }

  private var link: String {
    guard let snapshot = entry.snapshot else { return "mobile:///" }
    return entry.kind.present(snapshot: snapshot, steps: entry.steps).deepLink
  }

  @ViewBuilder private var content: some View {
    if let snapshot = entry.snapshot {
      let presentation = entry.kind.present(snapshot: snapshot, steps: entry.steps)
      switch family {
      case .systemMedium:
        MediumView(kind: entry.kind, presentation: presentation, snapshot: snapshot, history: entry.history)
      case .systemLarge:
        LargeView(presentation: presentation, snapshot: snapshot, steps: entry.steps)
      case .accessoryRectangular:
        AccessoryRectangularView(presentation: presentation)
      case .accessoryInline:
        AccessoryInlineView(presentation: presentation)
      default:
        SmallView(presentation: presentation)
      }
    } else {
      let copy = EmptyStateCopy.forMissingSnapshot(kind: entry.kind)
      EmptyStateView(title: copy.title, detail: copy.detail)
    }
  }
}

struct KoraWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "KoraWidget", intent: MetricIntent.self, provider: KoraProvider()) { entry in
      KoraWidgetView(entry: entry)
    }
    .configurationDisplayName("Kora")
    .description("Your day at a glance. Choose calories, steps, or protein.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
  }
}
```

- [ ] **Step 2: Replace the bundle**

Replace the entire contents of `apps/mobile/targets/kora-widgets/index.swift` with:

```swift
import SwiftUI
import WidgetKit

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    // One configurable widget (Reserve / Steps / Protein) replaces the former
    // NutritionWidget + StepsWidget pair. The steps metric is back in the
    // bundle because StepReading now resolves an unreadable HealthKit response
    // as unknown ("—") rather than a confident zero — the defect that pulled
    // the old StepsWidget on 2026-08-12.
    //
    // No @available annotation is needed: AppIntentConfiguration requires
    // iOS 17 and the extension's deployment target is raised to 17.0 in
    // expo-target.config.js, so the whole target is already gated.
    KoraWidget()
  }
}
```

- [ ] **Step 3: Delete the retired widgets**

```bash
git rm apps/mobile/targets/kora-widgets/NutritionWidget.swift \
       apps/mobile/targets/kora-widgets/StepsWidget.swift
```

- [ ] **Step 4: Verify nothing still references the deleted types**

Run:

```bash
grep -rn "NutritionWidget\|StepsWidget\|StepReader\b" apps/mobile/targets apps/mobile/widget-core-tests apps/mobile/src apps/mobile/modules
```

Expected: no matches other than the explanatory comment in `index.swift`.

- [ ] **Step 5: Verify both suites**

Run: `cd apps/mobile/widget-core-tests && swift test`
Expected: PASS — 34 tests, 0 failures.

Run: `cd apps/mobile && npm test`
Expected: PASS — 149 suites / 1181 tests, 0 failures. The snapshot wire format is unchanged, so no JS test should move.

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: clean, exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/targets/kora-widgets/KoraWidget.swift \
        apps/mobile/targets/kora-widgets/index.swift
git commit -m "feat(widgets): replace the widget pair with one configurable Kora widget"
```

---

### Task 11: Compile the extension and run the device gates

Nothing above has been compiled by Xcode — `swift test` only builds the pure subset. This task proves the extension actually builds, then runs the gates that no test can.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-kora-widgets-design.md` (record gate results)

- [ ] **Step 1: Build the extension**

```bash
cd apps/mobile && npx expo prebuild --platform ios --no-install
```

Expected: succeeds. Then confirm the target picked up iOS 17 while the app stayed at 16.4:

```bash
grep -n "IPHONEOS_DEPLOYMENT_TARGET" apps/mobile/ios/Kora.xcodeproj/project.pbxproj | sort -u
```

Expected: both `16.4` (app) and `17.0` (korawidgets) present.

Then build:

```bash
cd apps/mobile/ios && xcodebuild -workspace Kora.xcworkspace -scheme Kora \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug build 2>&1 | tail -30
```

Expected: `** BUILD SUCCEEDED **`. Fix any compile errors before continuing — this is the first real typecheck of every Swift file in this plan.

Note: `ios/` is gitignored. Do not commit it.

- [ ] **Step 2: Simulator verification (all gates except 2)**

Boot **iPhone 17 Pro** (never Pro Max). Install the app, sign in, then add the widget.

Verify and record:
- Widget appears in the gallery as a single "Kora" entry
- Long-press → Edit offers Energy reserve / Steps / Protein, and switching re-renders
- Small, medium and large all render for each metric
- Lock Screen rectangular and inline are legible
- Sign out → widget reverts to "Open Kora" (**gate 3, issue #135**)
- Toggle the simulator to a light appearance and re-check legibility in both

- [ ] **Step 3: Device gate 2 — the blocking one**

This CANNOT be verified on the simulator; it needs a real device with Health access actually denied.

On a physical device: **Settings → Privacy & Security → Health → Kora → turn OFF step reading.** Then view the steps widget.

Expected: `—`. **If it shows `0`, STOP.** Do not proceed — the defect that pulled the original widget has returned.

Also verify with access GRANTED: the widget's number matches the Health app *and* matches Kora's Home screen. Both now use cumulative-sum, so a Watch user should see them agree for the first time.

- [ ] **Step 4: Record the outcome in the spec**

Append a "Verification" section to `docs/superpowers/specs/2026-08-12-kora-widgets-design.md` recording each gate as passed, failed, or not run, with the date and device.

If **gate 2 could not be run**, apply the spec's stated fallback: remove `.steps` from `MetricChoice.caseDisplayRepresentations` and from `MetricKind.allCases` usage in the picker so the widget ships with Reserve and Protein only, and note in the spec that Steps is held back pending gate 2.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-12-kora-widgets-design.md
git commit -m "docs: record widget device gate results"
```

- [ ] **Step 6: Stop**

**Do NOT run `eas build`.** The user will request a build explicitly when ready.

---

## Notes for the implementer

- **The one invariant:** `nil` and `0` are different answers. If you find yourself writing `?? 0` on a step count, stop and reread Task 2.
- **The symlink rule:** a file under `targets/kora-widgets/` that is symlinked into `widget-core-tests/Sources/KoraWidgetCore/` may import **only Foundation**. If `swift test` starts failing with "no such module 'SwiftUI'", you symlinked a view.
- `apps/mobile/ios/` and `android/` are gitignored (CNG project). Never commit them.
- Scope every `git add` to the files the task names. A previous session swept an untracked file into a commit with `git add -A` from the repo root.
