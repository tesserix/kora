import Foundation

// Mirrors WidgetSnapshot in src/widgets/snapshot.ts verbatim. The two are one
// wire format; changing a field name here without changing it there silently
// breaks decoding and the widget falls back to its empty state.
struct NutritionSnapshot: Codable {
  let date: String
  let kcalConsumed: Double
  let kcalTarget: Double
  let proteinConsumed: Double
  let proteinTarget: Double
  let carbsConsumed: Double
  let carbsTarget: Double
  let fatConsumed: Double
  let fatTarget: Double
  let stepGoal: Double
}

// Pure logic, deliberately free of UserDefaults so widget-core-tests can
// exercise it with `swift test`. `now` and `timeZone` are injected so the
// midnight rollover is testable instead of depending on when the suite runs.
enum SnapshotLogic {
  static func decode(_ json: String) -> NutritionSnapshot? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(NutritionSnapshot.self, from: data)
  }

  static func localDayString(_ now: Date, timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: now)
  }

  /// Whether a snapshot describes the day `now` falls on.
  ///
  /// Without this guard a widget waking at 00:05 would render yesterday's
  /// calories as today's — the same invariant the food log enforces around
  /// logged_at. A figure must describe the day it claims to.
  static func isCurrent(_ snapshot: NutritionSnapshot, now: Date, timeZone: TimeZone) -> Bool {
    snapshot.date == localDayString(now, timeZone: timeZone)
  }
}

enum SnapshotStore {
  static let appGroup = "group.com.tesserix.kora"
  static let key = "nutritionSnapshot"

  /// The raw snapshot, whatever day it describes. Use for values that do not
  /// go stale — the step goal.
  static func raw() -> NutritionSnapshot? {
    guard let defaults = UserDefaults(suiteName: appGroup),
          let json = defaults.string(forKey: key)
    else { return nil }
    return SnapshotLogic.decode(json)
  }

  /// The snapshot ONLY when it describes today.
  static func current(now: Date = Date()) -> NutritionSnapshot? {
    guard let snapshot = raw() else { return nil }
    return SnapshotLogic.isCurrent(snapshot, now: now, timeZone: .current) ? snapshot : nil
  }
}
