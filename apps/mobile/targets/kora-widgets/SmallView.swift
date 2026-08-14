import SwiftUI

struct SmallView: View {
  let presentation: MetricPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(presentation.label)
        .font(WidgetTheme.engraved())
        .kerning(1.8)
        .foregroundStyle(WidgetTheme.mut)

      // The readout is handed to the dial, which places it in the clear band
      // below the hub — see DialGeometry.readoutTopOffset (issue #168).
      DialView(fraction: presentation.fraction, isOverTarget: presentation.isOverTarget) {
        readout
      }
      .frame(maxHeight: .infinity)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var readout: some View {
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
  }
}
