import SwiftUI

// The widget keeps the SYSTEM containerBackground so iOS 18 tinting and
// vibrancy keep working; identity is carried by the CONTENT — tick dial,
// accent needle, mono tabular numerals, engraved labels.
//
// Ink and mut therefore use the system's semantic colours rather than Kora's
// bg/ink tokens: on a tinted or vibrant home screen, hardcoded palette values
// stop adapting and go illegible.
enum WidgetTheme {
  /// THE accent. Needle, hub, redline, goal-hit bars. Nothing else.
  static let accent = Color(red: 1.0, green: 74.0 / 255.0, blue: 0.0)
  static let ink = Color.primary
  static let mut = Color.secondary
  static let tick = Color.primary.opacity(0.18)

  static func engraved(_ size: CGFloat = 9) -> Font {
    .system(size: size, weight: .medium, design: .monospaced)
  }

  static func numeral(_ size: CGFloat) -> Font {
    .system(size: size, weight: .bold, design: .monospaced)
  }
}
