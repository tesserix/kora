// swift-tools-version:5.9
import PackageDescription

// Tests for the widget's pure logic. Sources/KoraWidgetCore/Snapshot.swift is a
// SYMLINK to targets/kora-widgets/Snapshot.swift — the file the widget target
// actually compiles. Nothing is copied, so the tests cannot drift from what
// ships.
let package = Package(
  name: "KoraWidgetCore",
  platforms: [.macOS(.v13)],
  targets: [
    .target(name: "KoraWidgetCore"),
    .testTarget(name: "KoraWidgetCoreTests", dependencies: ["KoraWidgetCore"]),
  ]
)
