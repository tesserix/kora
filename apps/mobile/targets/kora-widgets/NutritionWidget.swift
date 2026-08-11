import SwiftUI
import WidgetKit

struct NutritionEntry: TimelineEntry {
  let date: Date
  let snapshot: NutritionSnapshot?
}

struct NutritionProvider: TimelineProvider {
  func placeholder(in context: Context) -> NutritionEntry {
    NutritionEntry(date: Date(), snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (NutritionEntry) -> Void) {
    completion(NutritionEntry(date: Date(), snapshot: SnapshotStore.current()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<NutritionEntry>) -> Void) {
    let entry = NutritionEntry(date: Date(), snapshot: SnapshotStore.current())
    // The app pushes a reload whenever the dashboard changes, so this cadence
    // only has to catch the midnight rollover that invalidates the snapshot.
    let refresh = Calendar.current.date(byAdding: .minute, value: 30, to: Date()) ?? Date()
    completion(Timeline(entries: [entry], policy: .after(refresh)))
  }
}

struct MacroBar: View {
  let label: String
  let consumed: Double
  let target: Double

  private var fraction: Double {
    target > 0 ? min(consumed / target, 1) : 0
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption2).foregroundStyle(.secondary)
      ProgressView(value: fraction).tint(.green)
      Text("\(Int(consumed))/\(Int(target))g").font(.caption2).monospacedDigit()
    }
  }
}

struct NutritionWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: NutritionEntry

  var body: some View {
    if let snapshot = entry.snapshot {
      VStack(alignment: .leading, spacing: 6) {
        Text("\(Int(max(snapshot.kcalTarget - snapshot.kcalConsumed, 0)))")
          .font(.system(size: family == .systemSmall ? 34 : 40, weight: .bold))
          .monospacedDigit()
        Text("kcal left").font(.caption).foregroundStyle(.secondary)
        if family == .systemMedium {
          HStack(spacing: 10) {
            MacroBar(label: "Protein", consumed: snapshot.proteinConsumed, target: snapshot.proteinTarget)
            MacroBar(label: "Carbs", consumed: snapshot.carbsConsumed, target: snapshot.carbsTarget)
            MacroBar(label: "Fat", consumed: snapshot.fatConsumed, target: snapshot.fatTarget)
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .containerBackground(.fill.tertiary, for: .widget)
    } else {
      VStack(spacing: 4) {
        Text("Open Kora").font(.headline)
        Text("to see today's calories").font(.caption).foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .containerBackground(.fill.tertiary, for: .widget)
    }
  }
}

struct NutritionWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KoraNutrition", provider: NutritionProvider()) { entry in
      NutritionWidgetView(entry: entry)
        .widgetURL(URL(string: "mobile:///diary"))
    }
    .configurationDisplayName("Calories")
    .description("Calories remaining today.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
