import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

/// Resolves HealthKit's ambiguity about today's step count.
///
/// iOS deliberately will not disclose whether an app holds READ permission:
/// `authorizationStatus(for:)` reports `.notDetermined` for a denied read, by
/// design. So "denied" and "hasn't walked yet" both surface as an absent sum
/// and cannot be told apart from a single query.
///
/// The previous implementation resolved that by returning 0, which put a
/// confident zero on the home screen on the strength of no data — the reason
/// the steps widget was pulled from the bundle on 2026-08-12.
///
/// The probe is what disambiguates: if ANY step sample exists in the last 7
/// days, reads work and today's absence is a real zero. If the window is
/// empty too, we cannot read Health and the honest answer is "unknown".
enum StepReading {
  /// - Parameters:
  ///   - todaySum: `sumQuantity()` for today, or nil when absent.
  ///   - probeFoundSamples: whether the 7-day probe found any sample at all.
  /// - Returns: the step count, or nil for unknown. Callers MUST render nil
  ///   as "—" and never as 0.
  static func resolve(todaySum: Double?, probeFoundSamples: Bool) -> Int? {
    if let sum = todaySum, sum.isFinite {
      return max(Int(sum.rounded()), 0)
    }
    return probeFoundSamples ? 0 : nil
  }
}
