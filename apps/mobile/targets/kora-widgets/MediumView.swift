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
        detail: "\(Int(snapshot.proteinConsumed.rounded())) / \(Int(snapshot.proteinTarget.rounded())) g"
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
    guard !known.isEmpty else { return EmptyStateCopy.stepsHistoryUnknown }
    let avg = known.reduce(0, +) / known.count
    let hits = known.filter { snapshot.stepGoal > 0 && Double($0) >= snapshot.stepGoal }.count
    return "avg \(Format.grouped(avg)) · \(hits) goal days"
  }

  private func ratio(_ value: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return value / target
  }
}
