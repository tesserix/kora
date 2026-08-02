import NetInfo from "@react-native-community/netinfo";
import { onlineManager } from "@tanstack/react-query";
import { installConnectivity, isOnline } from "../connectivity";

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));

test("installConnectivity mirrors netinfo state into react-query's onlineManager", () => {
  const unsubscribe = installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls[0][0];

  handler({ isConnected: false, isInternetReachable: false });
  expect(onlineManager.isOnline()).toBe(false);
  expect(isOnline()).toBe(false);

  handler({ isConnected: true, isInternetReachable: true });
  expect(onlineManager.isOnline()).toBe(true);
  expect(isOnline()).toBe(true);

  unsubscribe();
});

test("a connected interface with unknown reachability counts as online", () => {
  installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];
  // isInternetReachable is null while netinfo is still probing. Treating that
  // as offline would wrongly queue writes that would have succeeded.
  handler({ isConnected: true, isInternetReachable: null });
  expect(isOnline()).toBe(true);
});
