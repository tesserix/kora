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
