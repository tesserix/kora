import SwiftUI

/// An engraved label over a recessed progress track. The widget's equivalent
/// of the app's macro rows.
struct TrackView: View {
  let label: String
  let fraction: Double
  let detail: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(WidgetTheme.engraved(8))
        .kerning(1.4)
        .foregroundStyle(WidgetTheme.mut)

      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(WidgetTheme.tick)
          Capsule()
            .fill(fraction > 1 ? WidgetTheme.accent : WidgetTheme.ink.opacity(0.85))
            .frame(width: geo.size.width * min(max(fraction, 0), 1))
        }
      }
      .frame(height: 5)

      if let detail {
        Text(detail)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .monospacedDigit()
          .foregroundStyle(WidgetTheme.ink)
      }
    }
  }
}
