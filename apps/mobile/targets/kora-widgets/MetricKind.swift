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
