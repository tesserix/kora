import AppIntents
import WidgetKit

// AppIntents requires iOS 17, which is why the extension's deployment target
// is raised in expo-target.config.js while the app stays at 16.4.
//
// MetricChoice is a separate type from MetricKind on purpose: MetricKind is
// pure Foundation so it can be unit-tested by the SPM package, and importing
// AppIntents into it would break `swift test` on macOS.

enum MetricChoice: String, AppEnum {
  case reserve
  case steps
  case protein

  static var typeDisplayRepresentation: TypeDisplayRepresentation { "Metric" }

  static var caseDisplayRepresentations: [MetricChoice: DisplayRepresentation] = [
    .reserve: DisplayRepresentation(title: "Energy reserve", subtitle: "Calories left today"),
    .steps: DisplayRepresentation(title: "Steps", subtitle: "Steps against your goal"),
    .protein: DisplayRepresentation(title: "Protein", subtitle: "Protein against your target"),
  ]

  var kind: MetricKind {
    switch self {
    case .reserve: return .reserve
    case .steps: return .steps
    case .protein: return .protein
    }
  }
}

struct MetricIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource { "Kora" }
  static var description: IntentDescription { "Choose what this widget shows." }

  @Parameter(title: "Show", default: .reserve)
  var metric: MetricChoice

  init() {}

  init(metric: MetricChoice) {
    self.metric = metric
  }
}
