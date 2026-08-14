import { fireEvent, render as rtlRender } from "@testing-library/react-native";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { Linking } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { router } from "expo-router";

import CaptureScreen from "../capture";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

// Mirrors capture.test.tsx's mock: same-shape classes so the `instanceof`
// narrowing in capture.tsx's ottoErrorMessage still works, without pulling in
// the real "@/lib/api" -> "@/lib/firebase" -> AsyncStorage's native module.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  AuthTokenError: class AuthTokenError extends Error {},
  NetworkError: class NetworkError extends Error {},
  ResponseParseError: class ResponseParseError extends Error {},
}));

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => ({ mutate: jest.fn(), isPending: false }),
  useResolvePhoto: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveVoice: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveBarcode: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateLog: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

function render(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  (router.back as jest.Mock).mockReset();
  (router.push as jest.Mock).mockReset();
  (useCameraPermissions as jest.Mock).mockReset().mockReturnValue([
    { granted: true, status: "granted", canAskAgain: true, expires: "never" },
    jest.fn(async () => ({ granted: true, status: "granted" })),
    jest.fn(async () => ({ granted: true, status: "granted" })),
  ]);
  jest.spyOn(Linking, "openSettings").mockResolvedValue();
});

// Camera permission is only ever checked proactively (without the user tapping
// anything first) in Scan mode — see capture.tsx's mode==="scan" effect — so
// that's the mode renderCapture switches into to exercise the denied state.
//
// Three distinct PermissionStatus values matter here (expo-modules-core's
// PermissionStatus enum: "granted" | "undetermined" | "denied" — see
// node_modules/expo-modules-core/build/PermissionsInterface.d.ts). Both
// "undetermined" and "denied" carry `granted: false`, which is exactly the
// bug this helper exists to pin: gating the denied card on `granted ===
// false` instead of `status === "denied"` misfires on "undetermined" too.
async function renderCapture(opts: {
  cameraPermission?: "granted" | "denied" | "undetermined";
  mode?: "barcode";
}) {
  const status = opts.cameraPermission ?? "granted";
  const granted = status === "granted";
  (useCameraPermissions as jest.Mock).mockReturnValue([
    { granted, status, canAskAgain: !granted ? false : true, expires: "never" },
    jest.fn(async () => ({ granted, status })),
    jest.fn(async () => ({ granted, status })),
  ]);

  const rendered = await render(<CaptureScreen />);
  await fireEvent.press(await rendered.findByText("Scan"));
  return rendered;
}

test("a denied camera permission offers a route to Settings", async () => {
  const { getByText } = await renderCapture({ cameraPermission: "denied" });
  fireEvent.press(getByText("Open Settings"));
  expect(Linking.openSettings).toHaveBeenCalled();
});

test("a denied camera permission still offers a way to log", async () => {
  const { getByText } = await renderCapture({ cameraPermission: "denied" });
  expect(getByText(/describe it/i)).toBeTruthy();
});

// The placeholder drew a scan line, so a screen that could not scan looked
// like it was scanning.
test("the denied barcode state does not render a scan line", async () => {
  const { queryByTestId } = await renderCapture({ cameraPermission: "denied", mode: "barcode" });
  expect(queryByTestId("scan-line")).toBeNull();
});

test("no control renders without an action", async () => {
  const { queryByLabelText } = await renderCapture({});
  expect(queryByLabelText("Photo library")).toBeNull();
});

// Fix round 1, Finding 1 — pins all three PermissionStatus values distinctly
// so the granted/undetermined/denied trio can never silently collapse back
// into two again.
test("a granted camera permission renders the live camera, not the denied card", async () => {
  const { findByTestId, queryByTestId, queryByText } = await renderCapture({ cameraPermission: "granted" });
  expect(await findByTestId("barcode-scanner")).toBeTruthy();
  expect(queryByTestId("capture-permission-denied")).toBeNull();
  expect(queryByText("Open Settings")).toBeNull();
});

// The regression test: useCameraPermissions auto-fetches on mount (default
// {get: true}), so on a user's very first Scan the hook can resolve to
// {granted: false, status: "undetermined"} before the native OS prompt is
// even answered. This MUST fail if the denied-card gate reverts to
// `granted === false`, which is also true for this state.
test("an undetermined camera permission does not render the denied card", async () => {
  const { queryByTestId, queryByText } = await renderCapture({ cameraPermission: "undetermined" });
  expect(queryByTestId("capture-permission-denied")).toBeNull();
  expect(queryByText("Open Settings")).toBeNull();
});

test("a denied camera permission renders the denied card, not the live camera", async () => {
  const { getByText, queryByTestId } = await renderCapture({ cameraPermission: "denied" });
  expect(getByText("Open Settings")).toBeTruthy();
  expect(queryByTestId("barcode-scanner")).toBeNull();
});
