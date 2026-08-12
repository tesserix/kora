import SwiftUI

/// Large is ALWAYS the whole day, whatever metric is configured — it is the
/// only family with room for secondary figures to be legible.
struct LargeView: View {
  let presentation: MetricPresentation
  let snapshot: NutritionSnapshot
  let steps: Int?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 16) {
        SmallView(presentation: presentation)
          .frame(width: 132)

        VStack(alignment: .leading, spacing: 10) {
          TrackView(
            label: "PROTEIN",
            fraction: ratio(snapshot.proteinConsumed, snapshot.proteinTarget),
            detail: "\(Int(snapshot.proteinConsumed)) / \(Int(snapshot.proteinTarget)) g"
          )
          HStack(spacing: 12) {
            TrackView(label: "CARBS", fraction: ratio(snapshot.carbsConsumed, snapshot.carbsTarget), detail: nil)
            TrackView(label: "FAT", fraction: ratio(snapshot.fatConsumed, snapshot.fatTarget), detail: nil)
          }
          HStack(spacing: 18) {
            figure(label: "STEPS", value: steps.map(Format.grouped) ?? "—")
            figure(label: "GOAL", value: Format.grouped(Int(snapshot.stepGoal)))
          }
        }
      }

      Divider().overlay(WidgetTheme.tick)

      Text("LOGGED TODAY")
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)

      // The snapshot carries totals, not individual meals, so this family
      // shows the day's macro totals as its detail rather than a meal list.
      // Adding meals would require widening the wire format on both sides —
      // out of scope for this plan (see spec: the wire format does not change).
      HStack(spacing: 18) {
        figure(label: "EATEN", value: Format.grouped(Int(snapshot.kcalConsumed)))
        figure(label: "BUDGET", value: Format.grouped(Int(snapshot.kcalTarget)))
      }

      Spacer(minLength: 0)
    }
  }

  private func figure(label: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label)
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)
      Text(value)
        .font(.system(size: 13, weight: .semibold, design: .monospaced))
        .monospacedDigit()
        .foregroundStyle(WidgetTheme.ink)
    }
  }

  private func ratio(_ value: Double, _ target: Double) -> Double {
    guard target > 0 else { return 0 }
    return value / target
  }
}
