import SwiftUI

// iOS renders Lock Screen accessories as a flat white mask, so colour and the
// accent do not survive here — these are deliberately typographic. There is no
// accessoryCircular: the 33-tick dial turns to mush at 64pt under the mask.

struct AccessoryRectangularView: View {
  let presentation: MetricPresentation

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(presentation.label)
        .font(.system(size: 10, weight: .medium, design: .monospaced))
        .kerning(1.2)
      Text(presentation.heroText)
        .font(.system(size: 22, weight: .bold, design: .monospaced))
        .monospacedDigit()
        .minimumScaleFactor(0.7)
        .lineLimit(1)
      ProgressView(value: min(max(presentation.fraction, 0), 1))
        .progressViewStyle(.linear)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct AccessoryInlineView: View {
  let presentation: MetricPresentation

  var body: some View {
    // Inline gets ONE line beside the clock, so the label is dropped and the
    // caption carries the context: "6,420 of 10,000".
    Text("\(presentation.heroText) \(presentation.caption.lowercased())")
  }
}
