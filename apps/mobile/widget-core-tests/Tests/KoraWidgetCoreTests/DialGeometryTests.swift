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
