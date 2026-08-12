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
    // WidgetKit routes the gallery preview through this method. A fresh
    // install has no snapshot by definition, so without this branch the
    // gallery would show the empty state ("Open Kora...") instead of a
    // populated widget. Use the CONFIGURED metric, not always reserve, so the
    // preview matches what the user is about to place, and reuse the same
    // sample snapshot as placeholder(in:) rather than a second set of figures.
    if context.isPreview, SnapshotStore.current() == nil {
      let kind = configuration.metric.kind
      return KoraEntry(date: Date(), kind: kind, snapshot: Self.sample, steps: 6420, history: [])
    }
    return await entry(for: configuration, in: context)
  }

  func timeline(for configuration: MetricIntent, in context: Context) async -> Timeline<KoraEntry> {
    let current = await entry(for: configuration, in: context)

    // 30 minutes, not 15: WidgetKit's daily budget is roughly 40-70 refreshes
    // and 15 minutes asks for 96, so iOS throttles and the widget ends up LESS
    // fresh than a smaller ask would be. Reserve and Protein also get a push
    // reload from the app on every snapshot write (WidgetBridgeModule), so
    // this cadence mainly has to catch the midnight rollover and step drift.
    let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
    return Timeline(entries: [current], policy: .after(next))
  }

  private func entry(for configuration: MetricIntent, in context: Context) async -> KoraEntry {
    let kind = configuration.metric.kind
    let snapshot = SnapshotStore.current()

    // No snapshot means no account context at all — do not touch HealthKit,
    // and do not render a step count belonging to nobody.
    guard let snapshot else {
      return KoraEntry(date: Date(), kind: kind, snapshot: nil, steps: nil, history: [])
    }

    // Large always shows the day's steps alongside whatever metric is
    // configured (macro tracks + steps against goal), per the design spec —
    // so read Health here even when the configured metric isn't steps.
    guard kind == .steps || context.family == .systemLarge else {
      return KoraEntry(date: Date(), kind: kind, snapshot: snapshot, steps: nil, history: [])
    }

    let steps = await HealthReader.todaySteps()

    // last7Days() is only ever rendered by MediumView's steps history strip.
    // Small, Large and both accessories would pay for an extra
    // HKStatisticsCollectionQuery every 30 minutes for data they discard.
    let history: [DayStep]
    if kind == .steps, context.family == .systemMedium {
      history = await HealthReader.last7Days()
    } else {
      history = []
    }

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
