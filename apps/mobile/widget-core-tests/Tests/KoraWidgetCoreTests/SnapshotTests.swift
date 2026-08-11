import XCTest
@testable import KoraWidgetCore

// Fixed instants so the midnight rollover is deterministic rather than
// dependent on when the suite runs. 1786406400 = 2026-08-11T00:00:00Z.
private let aug11 = Date(timeIntervalSince1970: 1786406400)
private let utc = TimeZone(identifier: "UTC")!

private func json(date: String) -> String {
  """
  {"date":"\(date)","kcalConsumed":1200,"kcalTarget":2451,
   "proteinConsumed":60,"proteinTarget":156,"carbsConsumed":130,
   "carbsTarget":337,"fatConsumed":40,"fatTarget":73,
   "stepGoal":10000,"healthStatus":"authorized"}
  """
}

final class SnapshotTests: XCTestCase {
  func testDecodesEveryFieldTheAppWrites() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-11"))
    XCTAssertNotNil(snapshot)
    XCTAssertEqual(snapshot?.kcalConsumed, 1200)
    XCTAssertEqual(snapshot?.kcalTarget, 2451)
    XCTAssertEqual(snapshot?.stepGoal, 10000)
    XCTAssertEqual(snapshot?.healthStatus, "authorized")
  }

  func testDecodeReturnsNilOnGarbage() {
    XCTAssertNil(SnapshotLogic.decode("not json"))
    XCTAssertNil(SnapshotLogic.decode(""))
  }

  // A field renamed on the TypeScript side must fail decoding loudly here
  // rather than silently producing a zeroed snapshot.
  func testDecodeReturnsNilWhenAFieldIsMissing() {
    XCTAssertNil(SnapshotLogic.decode(#"{"date":"2026-08-11"}"#))
  }

  func testTodaysSnapshotIsCurrent() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-11"))!
    XCTAssertTrue(SnapshotLogic.isCurrent(snapshot, now: aug11, timeZone: utc))
  }

  // The bug this rule exists for: a widget waking after midnight must not
  // render yesterday's calories as today's.
  func testYesterdaysSnapshotIsNotCurrent() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-10"))!
    XCTAssertFalse(SnapshotLogic.isCurrent(snapshot, now: aug11, timeZone: utc))
  }

  // Staleness is judged in the USER'S timezone. At 00:30 UTC on the 11th it is
  // still the 10th in New York, so a snapshot dated the 10th is current there.
  func testStalenessIsJudgedInTheGivenTimezone() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-10"))!
    let justAfterMidnightUTC = Date(timeIntervalSince1970: 1786406400 + 1800)
    let newYork = TimeZone(identifier: "America/New_York")!
    XCTAssertTrue(SnapshotLogic.isCurrent(snapshot, now: justAfterMidnightUTC, timeZone: newYork))
    XCTAssertFalse(SnapshotLogic.isCurrent(snapshot, now: justAfterMidnightUTC, timeZone: utc))
  }
}
