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
