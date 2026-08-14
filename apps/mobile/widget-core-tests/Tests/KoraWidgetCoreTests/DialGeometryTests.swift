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

  // MARK: - Readout box (issue #168)

  /// Dial radii the shipping layouts actually produce: small fills its ~129pt
  /// square, medium draws the same face in a 118pt column, large in 132pt.
  private var familyRadii: [(name: String, radius: Double)] {
    [("small", 64.5), ("medium", 59), ("large", 66)]
  }

  /// The readout as SmallView composes it: a 26pt hero numeral, 3pt of
  /// spacing, an 8pt caption. Line height ≈ 1.2em.
  private var readoutContentHeight: Double { 26 * 1.2 + 3 + 8 * 1.2 }

  /// The widest hero the dial ever renders is a five-digit grouped step count,
  /// "10,000" — six glyphs of a monospaced face, advance ≈ 0.6em.
  private var widestHeroNaturalWidth: Double { 6 * 0.6 * 26 }
  /// SmallView's minimumScaleFactor: below this the hero would truncate.
  private var heroMinimumScaleFactor: Double { 0.6 }

  // THE bug: the unknown-value "—" (and every other hero) was drawn straight
  // over the accent hub, leaving both illegible.
  func testReadoutClearsTheHubInEveryFamily() {
    for family in familyRadii {
      let top = DialGeometry.readoutTopOffset(dialRadius: family.radius)
      let hub = DialGeometry.hubRadius(dialRadius: family.radius)
      XCTAssertGreaterThan(
        top, hub,
        "\(family.name): readout top \(top) overlaps hub of radius \(hub)"
      )
    }
  }

  // The three families are only samples; the box is defined in fractions of
  // the radius, so the clearance must hold at every size the dial is drawn at.
  func testReadoutClearsTheHubAtEveryDialSize() {
    for radius in stride(from: 20.0, through: 160.0, by: 5.0) {
      XCTAssertGreaterThan(
        DialGeometry.readoutTopOffset(dialRadius: radius),
        DialGeometry.hubRadius(dialRadius: radius),
        "radius \(radius)"
      )
    }
  }

  func testReadoutBoxStaysInsideTheDial() {
    for family in familyRadii {
      let bottom = DialGeometry.readoutTopOffset(dialRadius: family.radius)
        + DialGeometry.readoutMaxHeight(dialRadius: family.radius)
      XCTAssertLessThanOrEqual(bottom, family.radius, "\(family.name) overflows the dial")
    }
  }

  // Clearing the hub must not squeeze the hero and caption out of the dial.
  func testReadoutBoxHoldsTheHeroAndCaption() {
    for family in familyRadii {
      XCTAssertGreaterThanOrEqual(
        DialGeometry.readoutMaxHeight(dialRadius: family.radius), readoutContentHeight,
        "\(family.name) cannot hold the hero and caption"
      )
    }
  }

  // The known-value state must not regress: "10,000" has to fit the box
  // without hitting the truncating floor of minimumScaleFactor.
  func testWidestHeroFitsTheReadoutBoxWithoutTruncating() {
    for family in familyRadii {
      let available = DialGeometry.readoutMaxWidth(dialRadius: family.radius)
      XCTAssertGreaterThanOrEqual(
        available, widestHeroNaturalWidth * heroMinimumScaleFactor,
        "\(family.name): \(available)pt cannot hold a scaled \"10,000\""
      )
    }
  }

  func testDegenerateRadiusProducesNoNegativeOrNaNGeometry() {
    for value in [0.0, -10.0] {
      XCTAssertTrue(DialGeometry.hubRadius(dialRadius: value).isFinite)
      XCTAssertGreaterThanOrEqual(DialGeometry.hubRadius(dialRadius: value), 0)
      XCTAssertTrue(DialGeometry.readoutTopOffset(dialRadius: value).isFinite)
      XCTAssertTrue(DialGeometry.readoutMaxHeight(dialRadius: value).isFinite)
      XCTAssertEqual(DialGeometry.readoutMaxWidth(dialRadius: value), 0, accuracy: 0.001)
    }
  }
}
