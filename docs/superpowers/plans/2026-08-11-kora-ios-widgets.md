# iOS Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two iOS home screen widgets — nutrition (kcal + macros) and steps — for the Kora app.

**Architecture:** `@bacons/apple-targets` generates a WidgetKit extension at prebuild from Swift sources tracked in `apps/mobile/targets/kora-widgets/`. The app writes a JSON snapshot (nutrition figures, step goal, health status) into an App Group and reloads timelines; the widget renders it. The step *count* is read live from HealthKit inside the extension.

**Tech Stack:** Expo SDK 57, React Native 0.86, Swift/SwiftUI, WidgetKit, HealthKit, `@bacons/apple-targets` v5, local Expo module, jest.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-08-11-kora-ios-widgets-design.md`. Read it first.
- App Group id: `group.com.tesserix.kora`. Exact string, used in `app.json` and Swift.
- App bundle id: `com.tesserix.kora`. Widget target bundle id: `.widgets` (appended).
- `apps/mobile/ios/` is **gitignored**. Never commit it, never hand-edit the Xcode project — changes are wiped by `expo prebuild`.
- Toolchain verified present: Xcode 26.5, CocoaPods 1.17.0, macOS 26.6.1.
- Simulator for all manual verification: **iPhone 17 Pro** (udid `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`). Never the Pro Max.
- Nutrition figures are stale-guarded: a snapshot whose `date` ≠ today is treated as absent. `healthStatus` and `stepGoal` are exempt (see spec).
- An unknown step count renders `"—"`, never `0`.
- Widget sizes: `.systemSmall` and `.systemMedium` only. No lock screen, no App Intents.
- Run `npx expo prebuild -p ios --clean` after any change to `app.json` or `expo-target.config.js`.
- `apps/mobile/eslint.config.js` is untracked and pre-existing — leave it alone, never `git add -A`.

---

### Task 1: App Group, plugin, and a widget that appears

Riskiest infrastructure step, isolated so it can be verified before any real content exists. Deliverable: a widget named "Kora" appears in the widget gallery and renders static text on the home screen.

**Files:**
- Modify: `apps/mobile/app.json`
- Modify: `apps/mobile/package.json` (dependency added by the installer)
- Create: `apps/mobile/targets/kora-widgets/expo-target.config.js`
- Create: `apps/mobile/targets/kora-widgets/index.swift`
- Create: `apps/mobile/targets/kora-widgets/Info.plist`

**Interfaces:**
- Consumes: nothing.
- Produces: an App Group `group.com.tesserix.kora` on both targets; a widget target whose Swift sources live in `apps/mobile/targets/kora-widgets/`.

- [ ] **Step 1: Install the plugin**

```bash
cd apps/mobile
npx expo install @bacons/apple-targets
```

- [ ] **Step 2: Add the App Group and the plugin to `app.json`**

In `apps/mobile/app.json`, inside the `expo.ios` object add an `entitlements` key. The plugin mirrors this array onto every target that supports App Groups, so declaring it once here is what puts it on both the app and the widget:

```json
"ios": {
  "bundleIdentifier": "com.tesserix.kora",
  "entitlements": {
    "com.apple.security.application-groups": ["group.com.tesserix.kora"]
  }
}
```

Then append `"@bacons/apple-targets"` to the end of the existing `expo.plugins` array. Keep every existing plugin entry exactly as it is.

- [ ] **Step 3: Write the target config**

Create `apps/mobile/targets/kora-widgets/expo-target.config.js`:

```js
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "widget",
  name: "kora-widgets",
  displayName: "Kora",
  bundleIdentifier: ".widgets",
  // HealthKit is read live inside StepsWidget (Task 6); the App Group carries
  // the snapshot the app writes (Task 2). Both must be on the TARGET, not just
  // the app — an extension is a separate process with its own entitlements.
  entitlements: {
    "com.apple.security.application-groups":
      config.ios.entitlements["com.apple.security.application-groups"],
    "com.apple.developer.healthkit": true,
  },
  frameworks: ["SwiftUI", "WidgetKit", "HealthKit"],
});
```

- [ ] **Step 4: Write a placeholder widget so the target compiles**

Create `apps/mobile/targets/kora-widgets/index.swift`:

```swift
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
```

- [ ] **Step 5: Create the target Info.plist**

Create `apps/mobile/targets/kora-widgets/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.widgetkit-extension</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 6: Prebuild and confirm the target exists**

```bash
cd apps/mobile
npx expo prebuild -p ios --clean
grep -c "PBXNativeTarget" ios/Kora.xcodeproj/project.pbxproj
grep -o 'productType = "[^"]*"' ios/Kora.xcodeproj/project.pbxproj | sort | uniq -c
```

Expected: a `com.apple.product-type.app-extension` line appears alongside the existing `com.apple.product-type.application`. Before this task there was only the application type.

Also confirm the App Group landed on both:

```bash
grep -A 3 "application-groups" ios/Kora/Kora.entitlements
grep -rA 3 "application-groups" ios/.targets/
```

Expected: `group.com.tesserix.kora` in both.

- [ ] **Step 7: Build and install**

```bash
cd apps/mobile
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E
```

Expected: build succeeds. If it fails on signing for the extension, set `ios.appleTeamId` in `app.json` and re-run prebuild.

- [ ] **Step 8: Manually verify the widget appears**

On the iPhone 17 Pro simulator: long-press the home screen → tap the `+` → search "Kora" → confirm a small widget offering the text "Kora" → add it → confirm it renders on the home screen.

This is a manual gate. Do not proceed until the placeholder is visible.

- [ ] **Step 9: Commit**

```bash
git add apps/mobile/app.json apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/targets
git commit -m "feat(mobile): add a WidgetKit target and App Group via apple-targets"
```

---

### Task 2: widget-bridge local Expo module

The app-side channel: write JSON into the App Group and reload timelines.

**Files:**
- Create: `apps/mobile/modules/widget-bridge/expo-module.config.json`
- Create: `apps/mobile/modules/widget-bridge/index.ts`
- Create: `apps/mobile/modules/widget-bridge/ios/WidgetBridgeModule.swift`
- Create: `apps/mobile/modules/widget-bridge/ios/WidgetBridge.podspec`
- Create: `apps/mobile/src/widgets/__tests__/bridge.test.ts`

**Interfaces:**
- Consumes: the App Group from Task 1.
- Produces: `setSnapshot(json: string): void` and `clearSnapshot(): void`, exported from `apps/mobile/modules/widget-bridge`.

- [ ] **Step 1: Create the module scaffold**

```bash
cd apps/mobile
npx create-expo-module@latest --local widget-bridge
```

Accept the defaults. This creates `apps/mobile/modules/widget-bridge/`. Delete any generated example view/component files it produces — this module has no UI. Keep `expo-module.config.json`, `index.ts`, and the `ios/` directory.

- [ ] **Step 2: Write the Swift module**

Replace the contents of `apps/mobile/modules/widget-bridge/ios/WidgetBridgeModule.swift`:

```swift
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
```

- [ ] **Step 3: Write the TypeScript surface**

Replace the contents of `apps/mobile/modules/widget-bridge/index.ts`:

```ts
import { Platform, requireNativeModule } from "expo-modules-core";

type WidgetBridgeNative = {
  setSnapshot: (json: string) => void;
  clearSnapshot: () => void;
};

// Widgets are iOS-only, and the native module is absent on Android and in
// jest. Resolving lazily inside each call keeps a missing module from throwing
// at import time — the same guard src/health/useHealth.ts uses for HealthKit.
function native(): WidgetBridgeNative | null {
  if (Platform.OS !== "ios") return null;
  try {
    return requireNativeModule<WidgetBridgeNative>("WidgetBridge");
  } catch {
    return null;
  }
}

export function setSnapshot(json: string): void {
  native()?.setSnapshot(json);
}

export function clearSnapshot(): void {
  native()?.clearSnapshot();
}
```

- [ ] **Step 4: Write the failing test**

Create `apps/mobile/src/widgets/__tests__/bridge.test.ts`:

```ts
const mockSetSnapshot = jest.fn();
const mockClearSnapshot = jest.fn();
let mockPlatform = "ios";
let mockThrows = false;

jest.mock("expo-modules-core", () => ({
  get Platform() {
    return { OS: mockPlatform };
  },
  requireNativeModule: () => {
    if (mockThrows) throw new Error("native module not linked");
    return { setSnapshot: mockSetSnapshot, clearSnapshot: mockClearSnapshot };
  },
}));

import { clearSnapshot, setSnapshot } from "../../../modules/widget-bridge";

beforeEach(() => {
  mockSetSnapshot.mockClear();
  mockClearSnapshot.mockClear();
  mockPlatform = "ios";
  mockThrows = false;
});

test("setSnapshot forwards the json to the native module", () => {
  setSnapshot('{"date":"2026-08-11"}');
  expect(mockSetSnapshot).toHaveBeenCalledWith('{"date":"2026-08-11"}');
});

test("clearSnapshot calls through to the native module", () => {
  clearSnapshot();
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});

test("is a no-op on android rather than throwing", () => {
  mockPlatform = "android";
  expect(() => setSnapshot("{}")).not.toThrow();
  expect(mockSetSnapshot).not.toHaveBeenCalled();
});

// A dev client built before this module existed has no native side. Throwing
// at call time would take down whichever screen triggered the write.
test("is a no-op when the native module is missing", () => {
  mockThrows = true;
  expect(() => setSnapshot("{}")).not.toThrow();
  expect(() => clearSnapshot()).not.toThrow();
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/bridge.test.ts
```

Expected: FAIL — `Cannot find module '../../../modules/widget-bridge'` until Step 3's file exists, or assertion failures if it does.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/bridge.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Rebuild so the native module is linked**

```bash
cd apps/mobile
npx expo prebuild -p ios --clean
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E
```

Expected: build succeeds and the app launches.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/modules apps/mobile/src/widgets apps/mobile/package.json
git commit -m "feat(mobile): add a widget-bridge module for App Group snapshot writes"
```

---

### Task 3: Snapshot serialisation (pure TypeScript)

The snapshot shape, defined and fully tested on the side that can test it.

**Files:**
- Create: `apps/mobile/src/widgets/snapshot.ts`
- Create: `apps/mobile/src/widgets/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: `DashboardSummary` from `src/api/types.ts`; `HealthStatus` from `src/health/types.ts`.
- Produces: `type WidgetSnapshot`, and `buildSnapshot(input: BuildSnapshotInput): WidgetSnapshot`.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/widgets/__tests__/snapshot.test.ts`:

```ts
import type { DashboardSummary } from "@/api/types";
import { buildSnapshot } from "../snapshot";

const summary: DashboardSummary = {
  date: "2026-08-11",
  consumed: { kcal: 1200.4, protein_g: 60.7, carbs_g: 130.2, fat_g: 40.9, fiber_g: 12.1 },
  targets: { kcal: 2451, protein_g: 156, carbs_g: 337, fat_g: 73, fiber_g: 30 },
  water_ml: 500,
  streak_days: 3,
  source_counts: {},
};

test("carries the dashboard's own date, not today's", () => {
  // The widget's staleness guard compares this to the current local day, so it
  // must describe the day the FIGURES are for — never when they were written.
  expect(buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" }).date).toBe("2026-08-11");
});

test("rounds every figure to a whole number", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" });
  expect(snapshot.kcalConsumed).toBe(1200);
  expect(snapshot.kcalTarget).toBe(2451);
  expect(snapshot.proteinConsumed).toBe(61);
  expect(snapshot.carbsConsumed).toBe(130);
  expect(snapshot.fatConsumed).toBe(41);
});

test("carries the macro targets", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "authorized" });
  expect(snapshot.proteinTarget).toBe(156);
  expect(snapshot.carbsTarget).toBe(337);
  expect(snapshot.fatTarget).toBe(73);
});

// The widget cannot discover either of these for itself — see the spec's
// "Why the snapshot carries health state".
test("carries the step goal and health status", () => {
  const snapshot = buildSnapshot({ summary, stepGoal: 10000, healthStatus: "denied" });
  expect(snapshot.stepGoal).toBe(10000);
  expect(snapshot.healthStatus).toBe("denied");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/snapshot.test.ts
```

Expected: FAIL — `Cannot find module '../snapshot'`.

- [ ] **Step 3: Write the implementation**

Create `apps/mobile/src/widgets/snapshot.ts`:

```ts
import type { DashboardSummary } from "@/api/types";
import type { HealthStatus } from "@/health/types";

/**
 * What the app hands the widget. Field names are mirrored verbatim by
 * `NutritionSnapshot` in targets/kora-widgets/Snapshot.swift — the two are a
 * single wire format and must be changed together.
 *
 * Figures are whole numbers: the widget has no room for decimals and rounding
 * once here keeps the app and the widget from disagreeing by a tenth.
 */
export type WidgetSnapshot = {
  /** The local day these figures describe, "YYYY-MM-DD". Drives the staleness guard. */
  date: string;
  kcalConsumed: number;
  kcalTarget: number;
  proteinConsumed: number;
  proteinTarget: number;
  carbsConsumed: number;
  carbsTarget: number;
  fatConsumed: number;
  fatTarget: number;
  /** Step goal, which lives in the app (useHealth's STEP_GOAL) and is invisible to the widget. */
  stepGoal: number;
  /** HealthKit never discloses READ authorization, so the widget cannot resolve this itself. */
  healthStatus: HealthStatus;
};

export type BuildSnapshotInput = {
  summary: DashboardSummary;
  stepGoal: number;
  healthStatus: HealthStatus;
};

export function buildSnapshot({ summary, stepGoal, healthStatus }: BuildSnapshotInput): WidgetSnapshot {
  return {
    date: summary.date,
    kcalConsumed: Math.round(summary.consumed.kcal),
    kcalTarget: Math.round(summary.targets.kcal),
    proteinConsumed: Math.round(summary.consumed.protein_g),
    proteinTarget: Math.round(summary.targets.protein_g),
    carbsConsumed: Math.round(summary.consumed.carbs_g),
    carbsTarget: Math.round(summary.targets.carbs_g),
    fatConsumed: Math.round(summary.consumed.fat_g),
    fatTarget: Math.round(summary.targets.fat_g),
    stepGoal,
    healthStatus,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/snapshot.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/widgets
git commit -m "feat(mobile): define the widget snapshot shape"
```

---

### Task 4: Write on refresh, clear on sign-out

**Files:**
- Create: `apps/mobile/src/widgets/useWidgetSync.ts`
- Create: `apps/mobile/src/widgets/__tests__/useWidgetSync.test.tsx`
- Modify: `apps/mobile/app/(tabs)/_layout.tsx`
- Modify: `apps/mobile/src/health/useHealth.ts` (export `STEP_GOAL`)

**Interfaces:**
- Consumes: `buildSnapshot`, `WidgetSnapshot` (Task 3); `setSnapshot`, `clearSnapshot` (Task 2).
- Produces: `useWidgetSync(): void`, a hook mounted once by the tabs layout.

- [ ] **Step 1: Export the step goal**

In `apps/mobile/src/health/useHealth.ts`, change `const STEP_GOAL = 10000;` to `export const STEP_GOAL = 10000;`. Nothing else in that file changes.

- [ ] **Step 2: Write the failing test**

Create `apps/mobile/src/widgets/__tests__/useWidgetSync.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";

const mockSetSnapshot = jest.fn();
const mockClearSnapshot = jest.fn();
jest.mock("../../../modules/widget-bridge", () => ({
  setSnapshot: (json: string) => mockSetSnapshot(json),
  clearSnapshot: () => mockClearSnapshot(),
}));

let mockDashboard: { data: unknown; isError: boolean } = { data: undefined, isError: false };
jest.mock("@/api/hooks", () => ({
  useDashboard: () => mockDashboard,
}));

let mockHealth = { status: "authorized" };
jest.mock("@/health/useHealth", () => ({
  useHealth: () => mockHealth,
  STEP_GOAL: 10000,
}));

// Mirrors src/lib/push.ts's usePushRegistration: the widget sync subscribes to
// auth state rather than reading it, because a sign-out must clear the snapshot
// even though nothing re-renders this hook.
let authCallback: ((user: { uid: string } | null) => void) | null = null;
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: { uid: string } | null) => void) => {
    authCallback = cb;
    return () => {
      authCallback = null;
    };
  },
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

import { useWidgetSync } from "../useWidgetSync";

function Harness() {
  useWidgetSync();
  return null;
}

const summary = {
  date: "2026-08-11",
  consumed: { kcal: 1200, protein_g: 60, carbs_g: 130, fat_g: 40, fiber_g: 12 },
  targets: { kcal: 2451, protein_g: 156, carbs_g: 337, fat_g: 73, fiber_g: 30 },
  water_ml: 0,
  streak_days: 0,
  source_counts: {},
};

beforeEach(() => {
  mockSetSnapshot.mockClear();
  mockClearSnapshot.mockClear();
  mockDashboard = { data: undefined, isError: false };
  mockHealth = { status: "authorized" };
  authCallback = null;
});

test("writes a snapshot once the dashboard resolves", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(1);
  const written = JSON.parse(mockSetSnapshot.mock.calls[0][0]);
  expect(written.kcalConsumed).toBe(1200);
  expect(written.stepGoal).toBe(10000);
  expect(written.healthStatus).toBe("authorized");
});

test("writes nothing while the dashboard has no data", async () => {
  await render(<Harness />);
  expect(mockSetSnapshot).not.toHaveBeenCalled();
});

// A failed refresh must never overwrite a good snapshot with nulls — the
// widget would flip to "Open Kora" while the user's real figures still exist.
test("a failed dashboard fetch leaves the existing snapshot alone", async () => {
  mockDashboard = { data: undefined, isError: true };
  await render(<Harness />);
  expect(mockSetSnapshot).not.toHaveBeenCalled();
  expect(mockClearSnapshot).not.toHaveBeenCalled();
});

// Otherwise the home screen keeps showing the previous user's calories after
// sign-out, visible with no app open to explain it.
test("clears the snapshot when the user signs out", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  expect(authCallback).not.toBeNull();

  authCallback?.(null);
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});

// Signing back IN must not clear — only the transition to null does.
test("does not clear when a user signs in", async () => {
  await render(<Harness />);
  authCallback?.({ uid: "u2" });
  expect(mockClearSnapshot).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/useWidgetSync.test.tsx
```

Expected: FAIL — `Cannot find module '../useWidgetSync'`.

- [ ] **Step 4: Write the implementation**

Create `apps/mobile/src/widgets/useWidgetSync.ts`:

```ts
import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { clearSnapshot, setSnapshot } from "../../modules/widget-bridge";
import { useDashboard } from "@/api/hooks";
import { STEP_GOAL, useHealth } from "@/health/useHealth";
import { auth, isFirebaseConfigured } from "@/lib/firebase";
import { buildSnapshot } from "./snapshot";

function today(): string {
  return new Date().toLocaleDateString("en-CA");
}

/**
 * Keeps the home screen widget in step with the app. Mounted once, by the tabs
 * layout.
 *
 * Reads the dashboard through the SAME query key the home screen already uses,
 * so React Query serves it from cache — this adds no request.
 *
 * Writes only on real data. A failed fetch deliberately leaves the previous
 * snapshot in place: the figures on the home screen are still the user's real
 * ones, and replacing them with an empty state because the network blipped
 * would be a downgrade, not a correction.
 */
export function useWidgetSync(): void {
  const dashboard = useDashboard(today());
  const health = useHealth();
  const summary = dashboard.data;

  // Sign-out is SUBSCRIBED to, not read. currentUserId() would be a snapshot
  // taken at render time, and nothing re-renders this hook when auth drops —
  // on sign-out the tabs layout unmounts and the clear would never fire.
  // Mirrors usePushRegistration in src/lib/push.ts.
  useEffect(() => {
    if (!isFirebaseConfigured || !auth) return;
    return onAuthStateChanged(auth, (user) => {
      if (!user) clearSnapshot();
    });
  }, []);

  useEffect(() => {
    if (!summary) return;
    setSnapshot(JSON.stringify(buildSnapshot({ summary, stepGoal: STEP_GOAL, healthStatus: health.status })));
  }, [summary, health.status]);
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/useWidgetSync.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Mount the hook**

In `apps/mobile/app/(tabs)/_layout.tsx`, add the import and call the hook inside the layout component body, before its `return`:

```tsx
import { useWidgetSync } from "@/widgets/useWidgetSync";
```

```tsx
  useWidgetSync();
```

- [ ] **Step 7: Run the full mobile suite**

```bash
cd apps/mobile && npx jest && npx tsc --noEmit
```

Expected: all suites pass, tsc silent. If the tabs layout has its own test, it may need the `modules/widget-bridge` mock added.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src apps/mobile/app
git commit -m "feat(mobile): sync a widget snapshot on dashboard refresh and sign-out"
```

---

### Task 5: Nutrition widget

**Files:**
- Create: `apps/mobile/targets/kora-widgets/Snapshot.swift`
- Create: `apps/mobile/targets/kora-widgets/NutritionWidget.swift`
- Modify: `apps/mobile/targets/kora-widgets/index.swift`
- Create: `apps/mobile/widget-core-tests/Package.swift`
- Create: `apps/mobile/widget-core-tests/Sources/KoraWidgetCore/Snapshot.swift` (symlink)
- Create: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/SnapshotTests.swift`

**Interfaces:**
- Consumes: the JSON written by Task 4, in the App Group from Task 1.
- Produces: `NutritionSnapshot`, `SnapshotStore.current(now:)`, and `NutritionWidget` for the bundle.

- [ ] **Step 1: Write the snapshot reader**

Create `apps/mobile/targets/kora-widgets/Snapshot.swift`:

```swift
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
  let healthStatus: String
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
  /// go stale — the step goal and the health status.
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
```

- [ ] **Step 1b: Create the Swift test package**

`@bacons/apple-targets` has no XCTest target type, so the tests live in a
standalone Swift package that symlinks the **real** shipped source. Verified
working on Swift 6.3.2 — SPM follows the symlink and compiles the actual file,
so the tests cannot drift from what ships.

```bash
cd apps/mobile
mkdir -p widget-core-tests/Sources/KoraWidgetCore widget-core-tests/Tests/KoraWidgetCoreTests
ln -s ../../../targets/kora-widgets/Snapshot.swift \
  widget-core-tests/Sources/KoraWidgetCore/Snapshot.swift
```

Verify the symlink resolves before going further:

```bash
head -3 apps/mobile/widget-core-tests/Sources/KoraWidgetCore/Snapshot.swift
```

Expected: the `import Foundation` line from the real file. A "No such file"
means the relative depth is wrong.

Create `apps/mobile/widget-core-tests/Package.swift`:

```swift
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
```

- [ ] **Step 1c: Write the failing Swift tests**

Create `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/SnapshotTests.swift`:

```swift
import XCTest
@testable import KoraWidgetCore

// Fixed instants so the midnight rollover is deterministic rather than
// dependent on when the suite runs. 1786406400 = 2026-08-11T00:00:00Z.
private let aug11 = Date(timeIntervalSince1970: 1786406400)
private let utc = TimeZone(identifier: "UTC")!

private func json(date: String) -> String {
  """
  {"date":"\(date)","kcalConsumed":1200,"kcalTarget":2451,
   "proteinConsumed":60,"proteinTarget":156,"carbsConsumed":130,
   "carbsTarget":337,"fatConsumed":40,"fatTarget":73,
   "stepGoal":10000,"healthStatus":"authorized"}
  """
}

final class SnapshotTests: XCTestCase {
  func testDecodesEveryFieldTheAppWrites() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-11"))
    XCTAssertNotNil(snapshot)
    XCTAssertEqual(snapshot?.kcalConsumed, 1200)
    XCTAssertEqual(snapshot?.kcalTarget, 2451)
    XCTAssertEqual(snapshot?.stepGoal, 10000)
    XCTAssertEqual(snapshot?.healthStatus, "authorized")
  }

  func testDecodeReturnsNilOnGarbage() {
    XCTAssertNil(SnapshotLogic.decode("not json"))
    XCTAssertNil(SnapshotLogic.decode(""))
  }

  // A field renamed on the TypeScript side must fail decoding loudly here
  // rather than silently producing a zeroed snapshot.
  func testDecodeReturnsNilWhenAFieldIsMissing() {
    XCTAssertNil(SnapshotLogic.decode(#"{"date":"2026-08-11"}"#))
  }

  func testTodaysSnapshotIsCurrent() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-11"))!
    XCTAssertTrue(SnapshotLogic.isCurrent(snapshot, now: aug11, timeZone: utc))
  }

  // The bug this rule exists for: a widget waking after midnight must not
  // render yesterday's calories as today's.
  func testYesterdaysSnapshotIsNotCurrent() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-10"))!
    XCTAssertFalse(SnapshotLogic.isCurrent(snapshot, now: aug11, timeZone: utc))
  }

  // Staleness is judged in the USER'S timezone. At 00:30 UTC on the 11th it is
  // still the 10th in New York, so a snapshot dated the 10th is current there.
  func testStalenessIsJudgedInTheGivenTimezone() {
    let snapshot = SnapshotLogic.decode(json(date: "2026-08-10"))!
    let justAfterMidnightUTC = Date(timeIntervalSince1970: 1786406400 + 1800)
    let newYork = TimeZone(identifier: "America/New_York")!
    XCTAssertTrue(SnapshotLogic.isCurrent(snapshot, now: justAfterMidnightUTC, timeZone: newYork))
    XCTAssertFalse(SnapshotLogic.isCurrent(snapshot, now: justAfterMidnightUTC, timeZone: utc))
  }
}
```

- [ ] **Step 1d: Run the Swift tests to verify they fail, then pass**

```bash
cd apps/mobile/widget-core-tests && swift test
```

Before `Snapshot.swift` has `SnapshotLogic`, expect a compile error naming
`SnapshotLogic`. Once Step 1's file is in place, expect: `Executed 6 tests,
with 0 failures`.

- [ ] **Step 2: Write the nutrition widget**

Create `apps/mobile/targets/kora-widgets/NutritionWidget.swift`:

```swift
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
```

- [ ] **Step 3: Replace the placeholder in the bundle**

Replace the contents of `apps/mobile/targets/kora-widgets/index.swift`:

```swift
import SwiftUI
import WidgetKit

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    NutritionWidget()
  }
}
```

- [ ] **Step 4: Rebuild**

```bash
cd apps/mobile
npx expo prebuild -p ios --clean
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E
```

Expected: build succeeds.

- [ ] **Step 5: Manually verify all three states**

1. **Normal:** open the app so the dashboard loads, then background it. Add the "Calories" widget at small and medium. Confirm the kcal figure matches the app's home screen, and that medium shows three macro bars.
2. **Empty:** delete the app, reinstall, add the widget without opening the app. Confirm "Open Kora".
3. **Deep link:** tap the widget. Confirm the app opens on the Diary tab.

Do not proceed until all three hold.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/targets apps/mobile/widget-core-tests
git commit -m "feat(mobile): add the nutrition widget and Snapshot tests"
```

---

### Task 6: Steps widget

**Files:**
- Create: `apps/mobile/targets/kora-widgets/StepsWidget.swift`
- Modify: `apps/mobile/targets/kora-widgets/index.swift`

**Interfaces:**
- Consumes: `SnapshotStore.raw()` (Task 5) for `stepGoal` and `healthStatus`.
- Produces: `StepsWidget` for the bundle.

- [ ] **Step 1: Write the steps widget**

Create `apps/mobile/targets/kora-widgets/StepsWidget.swift`:

```swift
import HealthKit
import SwiftUI
import WidgetKit

enum StepReader {
  static let store = HKHealthStore()

  /// Today's step total, or nil when it could not be read.
  ///
  /// nil and 0 are DIFFERENT answers and are rendered differently: 0 means the
  /// user has not moved, nil means we do not know. Collapsing them would put a
  /// confident zero on the home screen on the strength of no data.
  static func todaySteps() async -> Int? {
    guard HKHealthStore.isHealthDataAvailable() else { return nil }
    let type = HKQuantityType(.stepCount)
    let start = Calendar.current.startOfDay(for: Date())
    let predicate = HKQuery.predicateForSamples(withStart: start, end: Date())

    return await withCheckedContinuation { continuation in
      let query = HKStatisticsQuery(
        quantityType: type,
        quantitySamplePredicate: predicate,
        options: .cumulativeSum
      ) { _, statistics, error in
        if error != nil {
          continuation.resume(returning: nil)
          return
        }
        // No samples is a legitimate zero — HealthKit returns a nil sum for a
        // day with no recorded steps.
        guard let sum = statistics?.sumQuantity() else {
          continuation.resume(returning: 0)
          return
        }
        continuation.resume(returning: Int(sum.doubleValue(for: .count())))
      }
      store.execute(query)
    }
  }
}

struct StepsEntry: TimelineEntry {
  let date: Date
  let steps: Int?
  let goal: Double
  let healthStatus: String?
}

struct StepsProvider: TimelineProvider {
  func placeholder(in context: Context) -> StepsEntry {
    StepsEntry(date: Date(), steps: 0, goal: 10000, healthStatus: "authorized")
  }

  func getSnapshot(in context: Context, completion: @escaping (StepsEntry) -> Void) {
    Task { completion(await entry()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<StepsEntry>) -> Void) {
    Task {
      let current = await entry()
      // 15 minutes: frequent enough that a walk appears within a quarter hour,
      // sparse enough to stay inside the system's daily refresh budget. iOS
      // treats this as a request, not a guarantee.
      let refresh = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
      completion(Timeline(entries: [current], policy: .after(refresh)))
    }
  }

  private func entry() async -> StepsEntry {
    // Deliberately raw(), not current(): the goal and the authorization status
    // do not go stale the way a day's figures do, and expiring them at midnight
    // would flip a working widget into a "connect" prompt.
    let snapshot = SnapshotStore.raw()
    let status = snapshot?.healthStatus
    let goal = snapshot?.stepGoal ?? 10000
    guard status == "authorized" else {
      return StepsEntry(date: Date(), steps: nil, goal: goal, healthStatus: status)
    }
    return StepsEntry(date: Date(), steps: await StepReader.todaySteps(), goal: goal, healthStatus: status)
  }
}

struct StepsWidgetView: View {
  @Environment(\.widgetFamily) var family
  let entry: StepsEntry

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      .containerBackground(.fill.tertiary, for: .widget)
  }

  @ViewBuilder private var content: some View {
    if entry.healthStatus == nil {
      message(title: "Open Kora", detail: "to see your steps")
    } else if entry.healthStatus != "authorized" {
      message(title: "Connect Health", detail: "in Kora to see steps")
    } else {
      VStack(alignment: .leading, spacing: 6) {
        Text(entry.steps.map { "\($0)" } ?? "—")
          .font(.system(size: family == .systemSmall ? 34 : 40, weight: .bold))
          .monospacedDigit()
        Text("of \(Int(entry.goal)) steps").font(.caption).foregroundStyle(.secondary)
        if family == .systemMedium, let steps = entry.steps, entry.goal > 0 {
          ProgressView(value: min(Double(steps) / entry.goal, 1)).tint(.green)
        }
      }
    }
  }

  private func message(title: String, detail: String) -> some View {
    VStack(spacing: 4) {
      Text(title).font(.headline)
      Text(detail).font(.caption).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct StepsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "KoraSteps", provider: StepsProvider()) { entry in
      StepsWidgetView(entry: entry)
        .widgetURL(URL(string: "mobile:///progress"))
    }
    .configurationDisplayName("Steps")
    .description("Steps today against your goal.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
```

- [ ] **Step 2: Add it to the bundle**

Replace the contents of `apps/mobile/targets/kora-widgets/index.swift`:

```swift
import SwiftUI
import WidgetKit

@main
struct KoraWidgetBundle: WidgetBundle {
  var body: some Widget {
    NutritionWidget()
    StepsWidget()
  }
}
```

- [ ] **Step 3: Rebuild**

```bash
cd apps/mobile
npx expo prebuild -p ios --clean
EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo run:ios --device AD109A46-2F99-43C3-8AAA-FEE68DC8499E
```

- [ ] **Step 4: Manually verify**

The simulator reports no step data by default, so seed some: open the Health app on the simulator and add step samples for today, or accept a 0 and verify the states that do not need data.

1. **Authorized:** with the app opened at least once and Health granted, add the "Steps" widget. Confirm it shows a number (0 is acceptable) and "of 10000 steps".
2. **Not authorized:** deny Health in the app, reopen it so a fresh snapshot is written, then confirm the widget reads "Connect Health".
3. **No snapshot:** reinstall without opening the app; confirm "Open Kora".
4. **Deep link:** tap the widget; confirm the app opens on the Progress tab.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/targets
git commit -m "feat(mobile): add the steps widget with a live HealthKit read"
```

---

### Task 7: Deep-link guard and final verification

The widget URLs are strings in Swift that no TypeScript test touches. If a route is renamed, every in-app navigation keeps working and only the home screen breaks — silently. This task closes that gap.

**Files:**
- Create: `apps/mobile/src/widgets/__tests__/deepLinks.test.ts`

**Interfaces:**
- Consumes: the `widgetURL` strings in `NutritionWidget.swift` and `StepsWidget.swift`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/widgets/__tests__/deepLinks.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The widgets deep link by literal string in Swift. Nothing else in the app
// reads those strings, so a route rename would break a home screen tap and no
// other test would notice. This asserts every widgetURL still resolves to a
// real route file.
const TARGETS = join(__dirname, "../../../targets/kora-widgets");
const APP = join(__dirname, "../../../app");

function widgetURLs(file: string): string[] {
  const source = readFileSync(join(TARGETS, file), "utf8");
  return [...source.matchAll(/widgetURL\(URL\(string:\s*"mobile:\/\/([^"]*)"\)\)/g)].map((m) => m[1]);
}

function routeExists(path: string): boolean {
  const name = path.replace(/^\//, "");
  return existsSync(join(APP, "(tabs)", `${name}.tsx`)) || existsSync(join(APP, `${name}.tsx`));
}

test("the nutrition widget links to a route that exists", () => {
  const urls = widgetURLs("NutritionWidget.swift");
  expect(urls).toEqual(["/diary"]);
  expect(routeExists(urls[0])).toBe(true);
});

test("the steps widget links to a route that exists", () => {
  const urls = widgetURLs("StepsWidget.swift");
  expect(urls).toEqual(["/progress"]);
  expect(routeExists(urls[0])).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Temporarily change the `widgetURL` in `NutritionWidget.swift` to `"mobile:///nope"`, then:

```bash
cd apps/mobile && npx jest src/widgets/__tests__/deepLinks.test.ts
```

Expected: FAIL. This proves the guard actually catches a bad route rather than passing vacuously. Restore `"mobile:///diary"` afterwards.

- [ ] **Step 3: Run the test to verify it passes**

```bash
cd apps/mobile && npx jest src/widgets/__tests__/deepLinks.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 4: Run everything**

```bash
cd apps/mobile && npx jest && npx tsc --noEmit
cd apps/mobile/widget-core-tests && swift test
```

Expected: all jest suites pass (1068 existing tests plus the ~15 added here),
tsc silent, and `Executed 6 tests, with 0 failures` from swift test.

- [ ] **Step 5: Final manual pass**

On the iPhone 17 Pro simulator, with both widgets added at both sizes:

- Log a meal in the app, background it, confirm the nutrition widget's kcal figure drops within a few seconds.
- Sign out, confirm both widgets fall back to "Open Kora" rather than showing the signed-out user's figures.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/widgets
git commit -m "test(mobile): guard the widget deep links against route renames"
```

---

## Notes for the executor

- Every `npx expo prebuild -p ios --clean` wipes and regenerates `apps/mobile/ios/`. That is expected and safe: nothing under `ios/` is tracked.
- If the extension fails to sign, set `ios.appleTeamId` in `app.json`. The simulator does not need a real team, but a stale value can break the build.
- `@bacons/apple-targets` ships an agent skill (`npx skills add EvanBacon/expo-apple-targets`) with per-target reference docs. Worth installing if a target-level problem resists the docs above.
- The Swift in Tasks 5 and 6 has no automated tests, by the decision recorded in the spec. Treat the manual verification steps as the gate they are, and do not mark those tasks complete on a build success alone.

---

### Task 8: Make the app honest about unreadable health data

Fixes a live bug in the shipped app, found while verifying Task 6. HealthKit
never discloses read authorization, so `useHealth`'s `"authorized"` means only
"the prompt was shown". With access actually denied the app renders a confident
`0` steps and, because the connect affordance is gated on a status that is
never `"denied"`, offers no way back. Verified 2026-08-11: 3,500 steps in
HealthKit, Kora absent from Health → Profile → Apps, app showing "0 of 10,000".

**Files:**
- Modify: `apps/mobile/src/health/useHealth.ts`
- Modify: `apps/mobile/app/(tabs)/index.tsx:177` and the matching Sleep line
- Modify: `apps/mobile/src/health/__tests__/useHealth.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `useHealth()` returning `steps: null` when no samples are readable;
  `connect()` always routing to Health.

- [ ] **Step 1: Write the failing tests**

Add to `apps/mobile/src/health/__tests__/useHealth.test.tsx`, following the
mocking already used in that file:

```tsx
// HealthKit returns an empty sample array both when the user has genuinely not
// moved and when read access was denied — the two are indistinguishable. The
// app must therefore report "unknown" (null), never a confident 0.
test("reports null steps when no samples are readable", async () => {
  mockQueryQuantitySamples.mockResolvedValue([]);
  const { result } = renderHook(() => useHealth());
  await waitFor(() => expect(result.current.steps).toBeNull());
});

test("reports a real count when samples are readable", async () => {
  mockQueryQuantitySamples.mockResolvedValue([{ quantity: 3500 }]);
  const { result } = renderHook(() => useHealth());
  await waitFor(() => expect(result.current.steps).toEqual({ today: 3500, goal: 10000 }));
});

// The old connect() only opened Health when status === "denied", a state that
// cannot occur — so a user who denied had no route back.
test("connect always opens Health settings", async () => {
  mockQueryQuantitySamples.mockResolvedValue([]);
  const { result } = renderHook(() => useHealth());
  await waitFor(() => expect(result.current.steps).toBeNull());
  result.current.connect();
  expect(Linking.openURL).toHaveBeenCalledWith("x-apple-health://");
});
```

- [ ] **Step 2: Run them and confirm they fail**

`cd apps/mobile && npx jest src/health/__tests__/useHealth.test.tsx`
Expected: the null-steps and connect tests fail (current code yields
`{today: 0}` and never calls `openURL`).

- [ ] **Step 3: Make steps honest**

In `useHealth.ts`, replace the unconditional `setSteps({...})` with a null when
nothing was readable. Same treatment for sleep:

```ts
      // An empty sample array is ambiguous: no movement, or no read access —
      // HealthKit will not say which. Reporting 0 would assert the first on no
      // evidence, so report "unknown" and let the UI offer a way to check.
      const stepTotal = sumSteps(stepSamples);
      setSteps(stepSamples.length > 0 ? { today: Math.round(stepTotal), goal: STEP_GOAL } : null);
      const sleepMillis = sumAsleepMillis(sleepSamples);
      setSleep(sleepSamples.length > 0 ? { lastNightHours: Math.round((sleepMillis / MS_PER_HOUR) * 10) / 10 } : null);
```

- [ ] **Step 4: Make connect always work**

```ts
  // Always route to Health. The old `status === "denied"` guard was unreachable
  // (see the spec), which left a denied user with no way to grant access.
  const connect = useCallback(() => {
    void Linking.openURL("x-apple-health://");
    void load();
  }, [load]);
```

- [ ] **Step 5: Drive the UI off data, not the meaningless status**

In `app/(tabs)/index.tsx`, both vitals cards currently read
`state={health.status === "authorized" ? "value" : "connect"}`. Replace the
Steps one with `state={health.steps ? "value" : "connect"}` and the Sleep one
with `state={health.sleep ? "value" : "connect"}`.

A user who has genuinely taken no steps yet today will see the connect prompt.
That is the accepted trade: we cannot distinguish that case from denial, and a
denied user with no route back is the worse failure.

- [ ] **Step 6: Verify**

`cd apps/mobile && npx jest && npx tsc --noEmit` — all green. Fix any existing
home-screen test that assumed a `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src/health apps/mobile/app/\(tabs\)/index.tsx
git commit -m "fix(mobile): stop reporting unreadable health data as zero"
```

---

### Task 9: Remove healthStatus from the widget pipeline

The spec's "Connect Health in Kora" widget state is unreachable (see Task 8).
Remove the field and the branch rather than ship a state that cannot occur.

**Files:**
- Modify: `apps/mobile/src/widgets/snapshot.ts`, `__tests__/snapshot.test.ts`
- Modify: `apps/mobile/src/widgets/useWidgetSync.ts`, `__tests__/useWidgetSync.test.tsx`
- Modify: `apps/mobile/targets/kora-widgets/Snapshot.swift`
- Modify: `apps/mobile/targets/kora-widgets/StepsWidget.swift`
- Modify: `apps/mobile/widget-core-tests/Tests/KoraWidgetCoreTests/SnapshotTests.swift`

**Interfaces:**
- Produces: `WidgetSnapshot` and `NutritionSnapshot` without `healthStatus`;
  `buildSnapshot({ summary, stepGoal })`.

- [ ] **Step 1: Drop the field from the TypeScript side**

Remove `healthStatus` from the `WidgetSnapshot` type, from `BuildSnapshotInput`,
and from the object `buildSnapshot` returns. Remove the `HealthStatus` import.
Update `snapshot.test.ts`: delete the `healthStatus` assertion, keep the
`stepGoal` one, and drop `healthStatus` from every `buildSnapshot` call.

- [ ] **Step 2: Drop it from the sync hook**

In `useWidgetSync.ts` remove `healthStatus: health.status` from the
`buildSnapshot` call. `useHealth()` is still needed for `STEP_GOAL`? No — that
constant is imported directly. If `health` becomes unused after this, remove the
`useHealth()` call and its import entirely, and drop the now-dead `health.status`
from the effect's dependency array. Update `useWidgetSync.test.tsx` accordingly,
keeping every existing assertion.

- [ ] **Step 3: Drop it from Swift**

Remove `let healthStatus: String` from `NutritionSnapshot` in `Snapshot.swift`.

In `SnapshotTests.swift`, remove `"healthStatus":"authorized"` from the `json`
fixture and delete the assertion on it. The other five tests stay unchanged.

- [ ] **Step 4: Simplify StepsWidget**

Remove `healthStatus` from `StepsEntry`, remove the "Connect Health" branch from
`StepsWidgetView`, and remove the `guard status == "authorized"` from the
provider so it always attempts the read. The remaining states are: no snapshot →
"Open Kora"; snapshot present → the step count, or `"—"` when the read yields
nothing. Keep `stepGoal` sourced from `SnapshotStore.raw()`.

Keep the comment explaining that `nil` and `0` are different facts — it is the
reason `"—"` exists and is now the only guard against unknown-as-zero.

- [ ] **Step 5: Verify**

```bash
cd apps/mobile && npx jest && npx tsc --noEmit
cd apps/mobile/widget-core-tests && swift test
xcodebuild -workspace apps/mobile/ios/Kora.xcworkspace -scheme kora-widgets -sdk iphonesimulator -destination 'platform=iOS Simulator,id=AD109A46-2F99-43C3-8AAA-FEE68DC8499E' build
```

Expected: jest green, tsc silent, `Executed 5 tests, with 0 failures`, BUILD SUCCEEDED.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/widgets apps/mobile/targets apps/mobile/widget-core-tests
git commit -m "refactor(mobile): drop the unreachable health status from the widget pipeline"
```
