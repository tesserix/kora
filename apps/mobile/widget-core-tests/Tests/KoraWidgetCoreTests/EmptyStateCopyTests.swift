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

  func testStepsHistoryUnknownMatchesSpecVerbatim() {
    XCTAssertEqual(EmptyStateCopy.stepsHistoryUnknown, "Health access needed")
  }

  // This copy renders exactly where a number (avg steps) would otherwise go —
  // it must never read as if it were data.
  func testStepsHistoryUnknownContainsNoDigit() {
    XCTAssertNil(EmptyStateCopy.stepsHistoryUnknown.rangeOfCharacter(from: .decimalDigits))
  }
}
