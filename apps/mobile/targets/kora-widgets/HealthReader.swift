import Foundation
import HealthKit

// Deliberately decision-free: every judgement about what an absent sum MEANS
// lives in StepReading (pure, unit-tested). This file only runs queries.
// A widget extension CANNOT call requestAuthorization — only the app can —
// so this either reads or it does not.

struct DayStep: Identifiable, Sendable {
  let date: Date
  /// nil = unknown for that day. Rendered as a gap, never a zero-height bar.
  let steps: Int?
  var id: Date { date }
}

enum HealthReader {
  static let store = HKHealthStore()
  private static let probeDays = 7

  /// Today's steps, or nil when unknown. See StepReading for why the probe exists.
  static func todaySteps() async -> Int? {
    guard HKHealthStore.isHealthDataAvailable() else { return nil }
    let start = Calendar.current.startOfDay(for: Date())
    let todaySum = await cumulativeSum(from: start, to: Date())
    // A non-finite sum is not evidence of a working read — let it fall
    // through to the probe rather than passing probeFoundSamples: true on
    // its behalf, which would turn "no evidence" into a confident 0.
    if let todaySum, todaySum.isFinite { return StepReading.resolve(todaySum: todaySum, probeFoundSamples: true) }

    let probeStart = Calendar.current.date(byAdding: .day, value: -probeDays, to: start) ?? start
    let probeSum = await cumulativeSum(from: probeStart, to: Date())
    return StepReading.resolve(todaySum: nil, probeFoundSamples: probeSum != nil)
  }

  /// The last 7 days including today, oldest first, for the medium family's history strip.
  ///
  /// A denied read does not surface as an error or a nil collection — it
  /// surfaces as a collection whose buckets are all empty, indistinguishable
  /// from a genuinely quiet week. So a successful `HKStatisticsCollectionQuery`
  /// does NOT by itself mean the window is readable; per-day absence needs
  /// the same probe `todaySteps()` uses: if ANY day in the window has a
  /// sample, reads work and the other empty days are real zeros. If none do,
  /// the whole window is unknown.
  static func last7Days() async -> [DayStep] {
    guard HKHealthStore.isHealthDataAvailable() else { return [] }
    let cal = Calendar.current
    let todayStart = cal.startOfDay(for: Date())
    guard let anchor = cal.date(byAdding: .day, value: -(probeDays - 1), to: todayStart) else { return [] }

    let collection = await statisticsCollection(anchor: anchor)
    guard let collection else { return [] }

    var days: [(date: Date, sum: Double?)] = []
    for offset in 0..<probeDays {
      guard let day = cal.date(byAdding: .day, value: offset, to: anchor) else { continue }
      let stats = collection.statistics(for: day)
      let sum = stats?.sumQuantity()?.doubleValue(for: .count())
      days.append((date: day, sum: sum))
    }

    let windowReadable = days.contains { $0.sum != nil }
    return days.map { day in
      DayStep(date: day.date, steps: StepReading.resolve(todaySum: day.sum, probeFoundSamples: windowReadable))
    }
  }

  private static func cumulativeSum(from start: Date, to end: Date) async -> Double? {
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [.strictStartDate])
    return await withCheckedContinuation { continuation in
      let query = HKStatisticsQuery(
        quantityType: HKQuantityType(.stepCount),
        quantitySamplePredicate: predicate,
        options: .cumulativeSum
      ) { _, statistics, _ in
        // An error and an absent sum are the same fact here: nothing readable.
        // StepReading decides what that MEANS.
        continuation.resume(returning: statistics?.sumQuantity()?.doubleValue(for: .count()))
      }
      store.execute(query)
    }
  }

  private static func statisticsCollection(anchor: Date) async -> HKStatisticsCollection? {
    await withCheckedContinuation { continuation in
      // anchorDate only sets bucket boundaries, it does not bound the range —
      // without this predicate HealthKit enumerates the user's ENTIRE step
      // history to build the buckets, which can be years of Watch data. That
      // is thousands of buckets computed inside a widget extension's ~30 MB
      // memory ceiling and timeline deadline; the failure mode is a jetsam,
      // not a slow query, and it is invisible on a simulator with no data.
      let query = HKStatisticsCollectionQuery(
        quantityType: HKQuantityType(.stepCount),
        quantitySamplePredicate: HKQuery.predicateForSamples(withStart: anchor, end: Date(), options: [.strictStartDate]),
        options: .cumulativeSum,
        anchorDate: anchor,
        intervalComponents: DateComponents(day: 1)
      )
      query.initialResultsHandler = { _, collection, _ in
        continuation.resume(returning: collection)
      }
      store.execute(query)
    }
  }
}
