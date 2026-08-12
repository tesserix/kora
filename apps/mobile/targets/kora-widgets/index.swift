import SwiftUI
import WidgetKit

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    // One configurable widget (Reserve / Steps / Protein) replaces the former
    // NutritionWidget + StepsWidget pair. The steps metric is back in the
    // bundle because StepReading now resolves an unreadable HealthKit response
    // as unknown ("—") rather than a confident zero — the defect that pulled
    // the old StepsWidget on 2026-08-12.
    //
    // No @available annotation is needed: AppIntentConfiguration requires
    // iOS 17 and the extension's deployment target is raised to 17.0 in
    // expo-target.config.js, so the whole target is already gated.
    KoraWidget()
  }
}
