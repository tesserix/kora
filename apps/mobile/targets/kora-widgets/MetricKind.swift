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
  /// A single self-contained line for the Lock Screen inline accessory.
  /// Unlike `caption`, which is designed to be read alongside `heroText` in a
  /// two-line layout, this is pre-composed because the two are not always
  /// glueable: steps' caption ("OF 10,000") reads naturally after a leading
  /// number, but protein's ("38G TO GO") is already a complete phrase.
  let inlineText: String

  init(label: String, heroText: String, caption: String,
              fraction: Double, isOverTarget: Bool, deepLink: String, inlineText: String) {
    self.label = label
    self.heroText = heroText
    self.caption = caption
    self.fraction = fraction
    self.isOverTarget = isOverTarget
    self.deepLink = deepLink
    self.inlineText = inlineText
  }
}

enum MetricKind: String, CaseIterable, Sendable {
  case reserve
  case steps
  case protein

  /// `steps` is the RESOLVED step count: nil means unknown (see StepReading),
  /// and is rendered "—". It is deliberately not defaulted, so no caller can
  /// forget it and silently get a zero.
  /// Where a steps widget lands (kora#425).
  ///
  /// The dashboard, because that is where steps are RENDERED —
  /// `app/(tabs)/index.tsx` draws the steps telemetry cell and Trends draws no
  /// steps at all. It pointed at "mobile:///progress" until #425, which sent
  /// the one gesture meaning "show me my steps" to the only screen that could
  /// not answer it, and read to the user as the app opening on the wrong tab.
  ///
  /// Named rather than inlined so the known and unknown branches below cannot
  /// drift apart — they did not, but they were two separate string literals.
  private static let stepsDeepLink = "mobile:///"

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
        deepLink: "mobile:///",
        inlineText: "\(Format.grouped(abs(left))) kcal \(over ? "over" : "left")"
      )

    case .steps:
      let goal = snapshot.stepGoal
      guard let steps else {
        return MetricPresentation(
          label: "STEPS", heroText: "—", caption: "OF \(Format.grouped(Int(goal)))",
          fraction: 0, isOverTarget: false, deepLink: Self.stepsDeepLink,
          inlineText: "— of \(Format.grouped(Int(goal)))"
        )
      }
      return MetricPresentation(
        label: "STEPS",
        heroText: Format.grouped(steps),
        caption: "OF \(Format.grouped(Int(goal)))",
        fraction: Self.ratio(Double(steps), goal),
        isOverTarget: goal > 0 && Double(steps) > goal,
        deepLink: Self.stepsDeepLink,
        inlineText: "\(Format.grouped(steps)) of \(Format.grouped(Int(goal)))"
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
        deepLink: "mobile:///",
        inlineText: "\(Format.grouped(consumed))g of \(Format.grouped(target))g"
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
