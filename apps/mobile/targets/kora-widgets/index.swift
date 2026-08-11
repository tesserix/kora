import SwiftUI
import WidgetKit

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    NutritionWidget()
    // StepsWidget() intentionally excluded: it renders unknown-as-zero for
    // denied Health reads and has never been device-verified. Re-add only
    // after both are resolved (whole-branch review 2026-08-12).
  }
}
