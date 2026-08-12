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

  // inlineText is the pre-composed line for the Lock Screen inline accessory.
  // Unlike heroText + caption, it must always read as one coherent phrase.

  func testReserveInlineTextUnderBudget() {
    let p = MetricKind.reserve.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.inlineText, "1,180 kcal left")
  }

  func testReserveInlineTextOverBudget() {
    let over = NutritionSnapshot(
      date: "2026-08-12", kcalConsumed: 2700, kcalTarget: 2451,
      proteinConsumed: 88, proteinTarget: 160, carbsConsumed: 110, carbsTarget: 260,
      fatConsumed: 57, fatTarget: 80, stepGoal: 10000
    )
    let p = MetricKind.reserve.present(snapshot: over, steps: nil)
    XCTAssertEqual(p.inlineText, "249 kcal over")
  }

  func testStepsInlineTextKnown() {
    let p = MetricKind.steps.present(snapshot: snap, steps: 6420)
    XCTAssertEqual(p.inlineText, "6,420 of 10,000")
  }

  // THE invariant applies here too: an unknown step count must not become a
  // confident zero, even inside the composed inline string.
  func testStepsInlineTextUnknownShowsEmDashNotZero() {
    let p = MetricKind.steps.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.inlineText, "— of 10,000")
    XCTAssertTrue(p.inlineText.hasPrefix("—"))
    XCTAssertFalse(p.inlineText.hasPrefix("0"))
  }

  func testProteinInlineTextNotMet() {
    let p = MetricKind.protein.present(snapshot: snap, steps: nil)
    XCTAssertEqual(p.inlineText, "88g of 160g")
  }

  func testProteinInlineTextMet() {
    let met = NutritionSnapshot(
      date: "2026-08-12", kcalConsumed: 1271, kcalTarget: 2451,
      proteinConsumed: 170, proteinTarget: 160, carbsConsumed: 110, carbsTarget: 260,
      fatConsumed: 57, fatTarget: 80, stepGoal: 10000
    )
    let p = MetricKind.protein.present(snapshot: met, steps: nil)
    XCTAssertEqual(p.inlineText, "170g of 160g")
  }
}
