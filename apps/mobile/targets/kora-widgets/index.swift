import SwiftUI
import WidgetKit

struct PlaceholderEntry: TimelineEntry {
  let date: Date
}

struct PlaceholderProvider: TimelineProvider {
  func placeholder(in context: Context) -> PlaceholderEntry {
    PlaceholderEntry(date: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (PlaceholderEntry) -> Void) {
    completion(PlaceholderEntry(date: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<PlaceholderEntry>) -> Void) {
    completion(Timeline(entries: [PlaceholderEntry(date: Date())], policy: .never))
  }
}

struct PlaceholderWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KoraPlaceholder", provider: PlaceholderProvider()) { _ in
      Text("Kora")
        .containerBackground(.fill.tertiary, for: .widget)
    }
    .configurationDisplayName("Kora")
    .description("Placeholder — replaced in Task 5.")
    .supportedFamilies([.systemSmall])
  }
}

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    PlaceholderWidget()
  }
}
