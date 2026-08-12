import ExpoModulesCore
import UIKit
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

    // Lives on WidgetBridge rather than a dedicated module: it's the only
    // other native call the app needs, and adding it here avoids new podspec
    // plumbing for one function. The name is a mismatch with "widgets" but
    // that's the pragmatic tradeoff.
    //
    // Deep-links straight to Kora's Notifications settings pane (iOS 16+)
    // instead of the app's root Settings page, saving the user one extra
    // tap. Falls back to the app's root Settings page pre-iOS 16 or if the
    // notification-specific URL can't be opened.
    AsyncFunction("openNotificationSettings") { () -> Bool in
      await MainActor.run {
        if #available(iOS 16.0, *), let url = URL(string: UIApplication.openNotificationSettingsURLString) {
          UIApplication.shared.open(url)
          return true
        }
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return false }
        UIApplication.shared.open(url)
        return true
      }
    }
  }
}
