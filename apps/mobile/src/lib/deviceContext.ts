import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";

export interface DeviceContext {
  app_version: string;
  platform: string;
  os_version: string;
  device_model: string;
}

/** Client context attached to a feedback submission.
 *  Every field is coerced to a string: expo-device returns null on some
 *  simulators and unusual devices, and the API rejects non-strings. */
export function deviceContext(): DeviceContext {
  return {
    app_version: Constants.expoConfig?.version ?? "",
    platform: Platform.OS,
    os_version: Device.osVersion ?? "",
    device_model: Device.modelName ?? "",
  };
}
