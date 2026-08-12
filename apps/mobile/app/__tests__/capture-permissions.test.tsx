import { fireEvent, render as rtlRender } from "@testing-library/react-native";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { Linking } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { router } from "expo-router";

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

import CaptureScreen from "../capture";

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
async function renderCapture(opts: {
  cameraPermission?: "granted" | "denied";
  mode?: "barcode";
}) {
  const granted = opts.cameraPermission !== "denied";
  (useCameraPermissions as jest.Mock).mockReturnValue([
    { granted, status: granted ? "granted" : "denied", canAskAgain: !granted ? false : true, expires: "never" },
    jest.fn(async () => ({ granted, status: granted ? "granted" : "denied" })),
    jest.fn(async () => ({ granted, status: granted ? "granted" : "denied" })),
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
