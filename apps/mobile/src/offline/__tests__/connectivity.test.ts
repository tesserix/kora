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

// The case that makes the reachability check load-bearing: a captive portal or
// a dead uplink leaves isConnected true while nothing actually routes. Without
// this, every other assertion here still passes under a naive
// `!!state.isConnected` that ignores isInternetReachable entirely — so this is
// the only test that proves the check exists at all.
test("a connected interface that is known unreachable counts as offline", () => {
  installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];

  handler({ isConnected: true, isInternetReachable: true });
  expect(isOnline()).toBe(true);

  handler({ isConnected: true, isInternetReachable: false });
  expect(isOnline()).toBe(false);
});

test("a connected interface with unknown reachability counts as online", () => {
  installConnectivity();
  const handler = (NetInfo.addEventListener as jest.Mock).mock.calls.at(-1)![0];
  // isInternetReachable is null while netinfo is still probing. Treating that
  // as offline would wrongly queue writes that would have succeeded.
  handler({ isConnected: true, isInternetReachable: null });
  expect(isOnline()).toBe(true);
});
