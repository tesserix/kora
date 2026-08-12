import AppIntents
import SwiftUI
import WidgetKit

struct KoraEntry: TimelineEntry {
  let date: Date
  let kind: MetricKind
  /// nil when there is no snapshot for TODAY — drives the empty state.
  let snapshot: NutritionSnapshot?
  /// nil = unknown. Only ever consulted for the steps metric.
  let steps: Int?
  let history: [DayStep]
}

struct KoraProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> KoraEntry {
    // Representative figures, never zeros: a gallery preview full of zeros
    // reads as a broken widget.
    KoraEntry(date: Date(), kind: .reserve, snapshot: Self.sample, steps: 6420, history: [])
  }

  func snapshot(for configuration: MetricIntent, in context: Context) async -> KoraEntry {
    await entry(for: configuration)
  }

  func timeline(for configuration: MetricIntent, in context: Context) async -> Timeline<KoraEntry> {
    let current = await entry(for: configuration)

    // 30 minutes, not 15: WidgetKit's daily budget is roughly 40-70 refreshes
    // and 15 minutes asks for 96, so iOS throttles and the widget ends up LESS
    // fresh than a smaller ask would be. Reserve and Protein also get a push
    // reload from the app on every snapshot write (WidgetBridgeModule), so
    // this cadence mainly has to catch the midnight rollover and step drift.
    let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
    return Timeline(entries: [current], policy: .after(next))
  }

  private func entry(for configuration: MetricIntent) async -> KoraEntry {
    let kind = configuration.metric.kind
    let snapshot = SnapshotStore.current()

    // No snapshot means no account context at all — do not touch HealthKit,
    // and do not render a step count belonging to nobody.
    guard snapshot != nil else {
      return KoraEntry(date: Date(), kind: kind, snapshot: nil, steps: nil, history: [])
    }

    guard kind == .steps else {
      return KoraEntry(date: Date(), kind: kind, snapshot: snapshot, steps: nil, history: [])
    }

    let steps = await HealthReader.todaySteps()
    let history = await HealthReader.last7Days()
    return KoraEntry(date: Date(), kind: kind, snapshot: snapshot, steps: steps, history: history)
  }

  private static let sample = NutritionSnapshot(
    date: SnapshotLogic.localDayString(Date(), timeZone: .current),
    kcalConsumed: 1271, kcalTarget: 2451,
    proteinConsumed: 88, proteinTarget: 160,
    carbsConsumed: 110, carbsTarget: 260,
    fatConsumed: 57, fatTarget: 80, stepGoal: 10000
  )
}

struct KoraWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: KoraEntry

  var body: some View {
    content
      .containerBackground(.fill.tertiary, for: .widget)
      .widgetURL(URL(string: link))
  }

  private var link: String {
    guard let snapshot = entry.snapshot else { return "mobile:///" }
    return entry.kind.present(snapshot: snapshot, steps: entry.steps).deepLink
  }

  @ViewBuilder private var content: some View {
    if let snapshot = entry.snapshot {
      let presentation = entry.kind.present(snapshot: snapshot, steps: entry.steps)
      switch family {
      case .systemMedium:
        MediumView(kind: entry.kind, presentation: presentation, snapshot: snapshot, history: entry.history)
      case .systemLarge:
        LargeView(presentation: presentation, snapshot: snapshot, steps: entry.steps)
      case .accessoryRectangular:
        AccessoryRectangularView(presentation: presentation)
      case .accessoryInline:
        AccessoryInlineView(presentation: presentation)
      default:
        SmallView(presentation: presentation)
      }
    } else {
      let copy = EmptyStateCopy.forMissingSnapshot(kind: entry.kind)
      EmptyStateView(title: copy.title, detail: copy.detail)
    }
  }
}

struct KoraWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "KoraWidget", intent: MetricIntent.self, provider: KoraProvider()) { entry in
      KoraWidgetView(entry: entry)
    }
    .configurationDisplayName("Kora")
    .description("Your day at a glance. Choose calories, steps, or protein.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
  }
}
