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

  // StepReading.resolve treats a non-finite sum as absent regardless of what
  // the caller passes for probeFoundSamples — the caller's job (see
  // HealthReader.todaySteps) is to not short-circuit into probeFoundSamples:
  // true on the strength of a non-finite sum in the first place, since that
  // would fabricate the one signal this function trusts as "reads work".
  func testNonFiniteSumIsTreatedAsAbsent() {
    XCTAssertNil(StepReading.resolve(todaySum: Double.nan, probeFoundSamples: false))
    XCTAssertNil(StepReading.resolve(todaySum: Double.infinity, probeFoundSamples: false))
  }

  // If a caller ever does pass probeFoundSamples: true alongside a
  // non-finite sum, resolve still honors the probe result as a real zero —
  // resolve itself has no way to know the probe signal was fabricated.
  func testNonFiniteSumWithProbeSamplesStillDefersToProbe() {
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

// kora#420. "HealthKit is locked right now" and "this app cannot read Health
// at all" both arrive as an absent sum with an empty probe, and both used to
// resolve to the same silent unknown. They need different handling: one is
// transient and worth retrying in minutes, the other is not going to change
// on its own.
final class StepAvailabilityTests: XCTestCase {
  func testAUsableSumIsReadable() {
    XCTAssertEqual(
      StepReading.availability(todaySum: 6420, probeFoundSamples: false, databaseInaccessible: false),
      .readable)
  }

  // A locked read that still produced a sum is readable — the lock did not
  // cost us anything, so do not schedule a needless early refresh.
  func testASumWinsOverALockedFlag() {
    XCTAssertEqual(
      StepReading.availability(todaySum: 6420, probeFoundSamples: false, databaseInaccessible: true),
      .readable)
  }

  // No sum today, but the probe found samples: reads work, today is a real
  // zero. Still readable.
  func testProbeSamplesMakeItReadable() {
    XCTAssertEqual(
      StepReading.availability(todaySum: nil, probeFoundSamples: true, databaseInaccessible: true),
      .readable)
  }

  // Nothing anywhere AND the store said it was inaccessible: the device is
  // locked. Transient.
  func testNoEvidenceWithLockedStoreIsLocked() {
    XCTAssertEqual(
      StepReading.availability(todaySum: nil, probeFoundSamples: false, databaseInaccessible: true),
      .locked)
  }

  // Nothing anywhere and no lock reported: the pre-existing unknown, which
  // must NOT be retried every few minutes.
  func testNoEvidenceWithoutLockedStoreIsUnreadable() {
    XCTAssertEqual(
      StepReading.availability(todaySum: nil, probeFoundSamples: false, databaseInaccessible: false),
      .unreadable)
  }

  func testNonFiniteSumIsNotEvidenceOfAReadableStore() {
    XCTAssertEqual(
      StepReading.availability(todaySum: Double.nan, probeFoundSamples: false, databaseInaccessible: true),
      .locked)
  }
}
