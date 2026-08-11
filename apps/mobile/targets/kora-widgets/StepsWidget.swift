import HealthKit
import SwiftUI
import WidgetKit

enum StepReader {
  static let store = HKHealthStore()

  /// Today's step total, or nil when it could not be read.
  ///
  /// nil and 0 are DIFFERENT answers and are rendered differently: 0 means the
  /// user has not moved, nil means we do not know. Collapsing them would put a
  /// confident zero on the home screen on the strength of no data.
  static func todaySteps() async -> Int? {
    guard HKHealthStore.isHealthDataAvailable() else { return nil }
    let type = HKQuantityType(.stepCount)
    let start = Calendar.current.startOfDay(for: Date())
    let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())

    return await withCheckedContinuation { continuation in
      let query = HKStatisticsQuery(
        quantityType: type,
        quantitySamplePredicate: predicate,
        options: .cumulativeSum
      ) { _, statistics, error in
        if error != nil {
          continuation.resume(returning: nil)
          return
        }
        // No samples is a legitimate zero — HealthKit returns a nil sum for a
        // day with no recorded steps.
        guard let sum = statistics?.sumQuantity() else {
          continuation.resume(returning: 0)
          return
        }
        continuation.resume(returning: Int(sum.doubleValue(for: .count())))
      }
      store.execute(query)
    }
  }
}

struct StepsEntry: TimelineEntry {
  let date: Date
  let steps: Int?
  let goal: Double
  let healthStatus: String?
}

struct StepsProvider: TimelineProvider {
  func placeholder(in context: Context) -> StepsEntry {
    StepsEntry(date: Date(), steps: 0, goal: 10000, healthStatus: "authorized")
  }

  func getSnapshot(in context: Context, completion: @escaping (StepsEntry) -> Void) {
    Task { completion(await entry()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<StepsEntry>) -> Void) {
    Task {
      let current = await entry()
      // 15 minutes: frequent enough that a walk appears within a quarter hour,
      // sparse enough to stay inside the system's daily refresh budget. iOS
      // treats this as a request, not a guarantee.
      let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
      completion(Timeline(entries: [current], policy: .after(refresh)))
    }
  }

  private func entry() async -> StepsEntry {
    // Deliberately raw(), not current(): the goal and the authorization status
    // do not go stale the way a day's figures do, and expiring them at midnight
    // would flip a working widget into a "connect" prompt.
    let snapshot = SnapshotStore.raw()
    let status = snapshot?.healthStatus
    let goal = snapshot?.stepGoal ?? 10000
    guard status == "authorized" else {
      return StepsEntry(date: Date(), steps: nil, goal: goal, healthStatus: status)
    }
    return StepsEntry(date: Date(), steps: await StepReader.todaySteps(), goal: goal, healthStatus: status)
  }
}

struct StepsWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: StepsEntry

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .containerBackground(.fill.tertiary, for: .widget)
  }

  @ViewBuilder private var content: some View {
    if entry.healthStatus == nil {
      message(title: "Open Kora", detail: "to see your steps")
    } else if entry.healthStatus != "authorized" {
      message(title: "Connect Health", detail: "in Kora to see steps")
    } else {
      VStack(alignment: .leading, spacing: 6) {
        Text(entry.steps.map { "\($0)" } ?? "—")
          .font(.system(size: family == .systemSmall ? 34 : 40, weight: .bold))
          .monospacedDigit()
        Text("of \(Int(entry.goal)) steps").font(.caption).foregroundStyle(.secondary)
        if family == .systemMedium, let steps = entry.steps, entry.goal > 0 {
          ProgressView(value: min(Double(steps) / entry.goal, 1)).tint(.green)
        }
      }
    }
  }

  private func message(title: String, detail: String) -> some View {
    VStack(spacing: 4) {
      Text(title).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct StepsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KoraSteps", provider: StepsProvider()) { entry in
      StepsWidgetView(entry: entry)
        .widgetURL(URL(string: "mobile:///progress"))
    }
    .configurationDisplayName("Steps")
    .description("Steps today against your goal.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
