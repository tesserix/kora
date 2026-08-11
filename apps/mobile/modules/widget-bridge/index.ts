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
