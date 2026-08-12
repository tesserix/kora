import SwiftUI

struct SmallView: View {
  let presentation: MetricPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(presentation.label)
        .font(WidgetTheme.engraved())
        .kerning(1.8)
        .foregroundStyle(WidgetTheme.mut)

      ZStack {
        DialView(fraction: presentation.fraction, isOverTarget: presentation.isOverTarget)
        VStack(spacing: 3) {
          Text(presentation.heroText)
            .font(WidgetTheme.numeral(26))
            .monospacedDigit()
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .foregroundStyle(WidgetTheme.ink)
          Text(presentation.caption)
            .font(WidgetTheme.engraved(8))
            .kerning(1.4)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(WidgetTheme.mut)
        }
        .padding(.top, 14)
      }
      .frame(maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
