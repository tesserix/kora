import ExpoModulesCore
import WidgetKit

// The one place the app writes to the widget's App Group. The widget reads the
// same suite + key in Snapshot.swift (Task 5); if either string changes, both
// must change together.
private let appGroup = "group.com.tesserix.kora"
private let snapshotKey = "nutritionSnapshot"

public class WidgetBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    // Takes an already-serialised JSON string rather than a dictionary: the
    // shape is defined and tested in TypeScript (Task 3), so Swift stays a
    // dumb pipe and the two sides cannot disagree about field names.
    Function("setSnapshot") { (json: String) in
      UserDefaults(suiteName: appGroup)?.set(json, forKey: snapshotKey)
      WidgetCenter.shared.reloadAllTimelines()
    }

    // Called on sign-out. Without this the home screen keeps showing the
    // previous user's calories, visible with no app open to explain it.
    Function("clearSnapshot") {
      UserDefaults(suiteName: appGroup)?.removeObject(forKey: snapshotKey)
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
