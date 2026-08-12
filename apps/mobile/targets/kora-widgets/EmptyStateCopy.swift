import Foundation

// Foundation ONLY — symlinked into widget-core-tests. See MetricKind.swift.

enum EmptyStateCopy {
  /// Copy for "no snapshot": signed out, or the app has never been opened
  /// since install. Also the sign-out privacy path (issue #135) — the previous
  /// user's figures must leave the home screen entirely.
  static func forMissingSnapshot(kind: MetricKind) -> (title: String, detail: String) {
    switch kind {
    case .reserve: return ("Open Kora", "to see today's calories")
    case .steps: return ("Open Kora", "to see your steps")
    case .protein: return ("Open Kora", "to see your protein")
    }
  }
}
