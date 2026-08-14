import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

/// The dial's tick geometry, matching the app's GaugeDial and BrandMark:
/// a 230° arc swept from -205° to +25°, ticks lit up to value/target, the
/// last 10% classed as redline.
enum DialGeometry {
  static let tickCount = 33
  static let startDegrees = -205.0
  static let endDegrees = 25.0
  private static let redlineStartFraction = 0.9

  // MARK: - Face proportions
  //
  // Everything the face draws is a fraction of the dial's radius, so the same
  // geometry holds at every family's dial size. DialView reads these rather
  // than carrying its own literals.

  static let majorTickLengthFraction = 0.21
  static let minorTickLengthFraction = 0.13
  static let majorTickWidthFraction = 0.05
  static let minorTickWidthFraction = 0.035
  static let needleLengthFraction = 0.68
  static let needleWidthFraction = 0.062
  /// Diameter of the needle's hub, the opaque accent disc at the pivot.
  static let hubDiameterFraction = 0.16

  static func isMajor(index: Int) -> Bool { index % 4 == 0 }

  static func angleDegrees(index: Int) -> Double {
    startDegrees + (endDegrees - startDegrees) * progress(index)
  }

  static func isLit(index: Int, fraction: Double) -> Bool {
    progress(index) <= clamped(fraction)
  }

  static func isRedline(index: Int) -> Bool {
    progress(index) >= redlineStartFraction
  }

  static func needleAngleDegrees(fraction: Double) -> Double {
    startDegrees + (endDegrees - startDegrees) * clamped(fraction)
  }

  // MARK: - Readout box
  //
  // The hero numeral and its caption live in a box the dial hands them, below
  // the hub and inside the tick ring, so the readout can never be drawn over
  // either. Both insets are fractions of the radius, like everything else on
  // the face.

  private static let readoutClearanceFraction = 0.06
  private static let readoutBottomMarginFraction = 0.06

  /// Radius of the needle's hub for a dial of `dialRadius`.
  static func hubRadius(dialRadius: Double) -> Double {
    max(dialRadius, 0) * hubDiameterFraction / 2
  }

  /// How far BELOW the dial centre the readout box's top edge sits.
  ///
  /// Issue #168: the readout used to be a block centred on the dial nudged by
  /// a flat 14pt pad, which put its top edge ABOVE the centre — so the hero
  /// (an unknown value's `—` worst of all, being a single centred stroke)
  /// was drawn straight over the accent hub and neither could be read. The
  /// readout now starts below the hub, like a real instrument's odometer, and
  /// the clearance scales with the dial instead of being a fixed nudge.
  static func readoutTopOffset(dialRadius: Double) -> Double {
    let radius = max(dialRadius, 0)
    return hubRadius(dialRadius: radius) + radius * readoutClearanceFraction
  }

  /// Height available to the readout, from its top edge down to the dial's
  /// bottom edge less a margin.
  static func readoutMaxHeight(dialRadius: Double) -> Double {
    max(dialRadius, 0) * (1 - readoutBottomMarginFraction) - readoutTopOffset(dialRadius: dialRadius)
  }

  /// Widest the readout may be without touching the tick ring.
  ///
  /// The ring is open below the arc's ends, so only the part of the box above
  /// that line is constrained — and its lowest constrained edge is the
  /// narrowest point.
  static func readoutMaxWidth(dialRadius: Double) -> Double {
    let radius = max(dialRadius, 0)
    let innerRadius = radius * (1 - majorTickLengthFraction)
    let boxBottom = readoutTopOffset(dialRadius: radius) + readoutMaxHeight(dialRadius: radius)
    let arcEnd = radius * sin(endDegrees * .pi / 180)
    let constrainedDepth = min(max(boxBottom, 0), arcEnd)
    let halfWidth = (innerRadius * innerRadius - constrainedDepth * constrainedDepth).squareRoot()
    return halfWidth.isFinite ? max(halfWidth * 2, 0) : 0
  }

  private static func progress(_ index: Int) -> Double {
    guard tickCount > 1 else { return 0 }
    return Double(index) / Double(tickCount - 1)
  }

  // Over-target values pin the needle at full deflection rather than swinging
  // it past the scale — a real instrument's needle stops at the stop.
  private static func clamped(_ fraction: Double) -> Double {
    guard fraction.isFinite else { return 0 }
    return min(max(fraction, 0), 1)
  }
}
