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

extension StepReading {
  /// Whether today's step figure could be read, and if not, whether that is
  /// worth retrying soon (kora#420).
  ///
  /// `resolve` answers "what number do we show". This answers "is the absence
  /// of a number permanent". HealthKit's store is protected data: while the
  /// device is LOCKED every query fails with `errorDatabaseInaccessible`
  /// rather than returning samples, so a timeline that happens to refresh on
  /// a locked phone sees exactly what a denied read sees — no sum, empty
  /// probe. Folding the two together left the widget showing "unknown" until
  /// the next 30-minute slot or an app launch, whichever came first, which is
  /// the intermittent blank people actually report.
  enum Availability: Equatable {
    /// A figure was produced, or an absence was proven to be a real zero.
    case readable
    /// The store refused because the device is locked. Transient — retry soon.
    case locked
    /// No evidence reads work at all. Not going to change by itself, so do
    /// NOT burn the widget's refresh budget retrying it.
    case unreadable
  }

  /// - Parameters:
  ///   - todaySum: `sumQuantity()` for today, or nil when absent.
  ///   - probeFoundSamples: whether the 7-day probe found any sample at all.
  ///   - databaseInaccessible: whether any query failed with HealthKit's
  ///     `errorDatabaseInaccessible`.
  ///
  /// A usable sum or a positive probe wins outright: the lock cost us nothing
  /// in that case, and scheduling an early refresh for it would spend budget
  /// on a widget that is already correct.
  static func availability(
    todaySum: Double?,
    probeFoundSamples: Bool,
    databaseInaccessible: Bool
  ) -> Availability {
    if let sum = todaySum, sum.isFinite { return .readable }
    if probeFoundSamples { return .readable }
    return databaseInaccessible ? .locked : .unreadable
  }
}

