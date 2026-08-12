import { Platform, requireNativeModule } from "expo-modules-core";

type WidgetBridgeNative = {
  setSnapshot: (json: string) => void;
  clearSnapshot: () => void;
  openNotificationSettings: () => Promise<boolean>;
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

// Resolves false (never rejects to the caller) when the native module is
// absent or the call itself throws — callers fall back to Linking.openSettings.
export async function openNotificationSettings(): Promise<boolean> {
  const mod = native();
  if (!mod) return false;
  try {
    return await mod.openNotificationSettings();
  } catch {
    return false;
  }
}
