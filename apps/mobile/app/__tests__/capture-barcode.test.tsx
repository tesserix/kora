import { act, fireEvent, render as rtlRender, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Resolution } from "@/api/types";

// The real "@/lib/api" pulls in "@/lib/firebase" -> AsyncStorage's native
// module, which isn't available under Jest. Mirrors the minimal mock in
// capture.test.tsx — this file never exercises the error-message narrowing,
// but capture.tsx imports these names at module scope so they must exist.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  AuthTokenError: class AuthTokenError extends Error {},
  NetworkError: class NetworkError extends Error {},
  ResponseParseError: class ResponseParseError extends Error {},
}));

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

const mockResolveBarcodeMutate = jest.fn();

// Only the barcode-scan path is under test here, so the other capture modes'
// hooks are stubbed to inert no-ops — CaptureScreen still mounts all of them
// unconditionally.
jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => ({ mutate: jest.fn(), isPending: false }),
  useResolvePhoto: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveVoice: () => ({ mutate: jest.fn(), isPending: false }),
  useResolveBarcode: () => ({
    mutate: mockResolveBarcodeMutate,
    isPending: false,
  }),
  useCreateLog: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

import CaptureScreen from "../capture";

async function render(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeCandidate(id: string, name: string): Resolution["candidates"][number] {
  return {
    item: {
      id,
      name,
      brand: "",
      provenance: "afcd",
      serving_desc: "1 serving",
      serving_grams: 140,
      kcal_per_100g: 165,
      protein_per_100g: 31,
      carbs_per_100g: 0,
      fat_per_100g: 3.6,
    },
    portion_grams: 140,
    kcal: 231,
    match_score: 0.96,
    match_tier: "auto",
  };
}

function resolutionFixture(overrides: Partial<Resolution> = {}): Resolution {
  return {
    candidates: [makeCandidate("1", "Grilled chicken breast")],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
    ...overrides,
  };
}

beforeEach(() => {
  mockResolveBarcodeMutate.mockReset();
});

describe("barcode scanner re-arming", () => {
  test("a second barcode scans after the first one succeeds", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const scanner = await findByTestId("barcode-scanner");

    await act(async () => {
      scanner.props.onBarcodeScanned({ data: "5000112637922" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);
    const [, firstOptions] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => firstOptions.onSuccess(resolutionFixture()));

    await act(async () => {
      scanner.props.onBarcodeScanned({ data: "4008400402222" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
  });

  // The server answers "not recognized" with a 200 and a follow-up question,
  // not an error — so the error path never runs, and without a `finally` the
  // scanner stayed latched after this outcome.
  test("an unrecognised barcode does not latch the scanner", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const scanner = await findByTestId("barcode-scanner");

    await act(async () => {
      scanner.props.onBarcodeScanned({ data: "0000000000000" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);
    const [, firstOptions] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () =>
      firstOptions.onSuccess(
        resolutionFixture({ tier: "follow_up", follow_up_question: "Barcode not recognized", candidates: [] }),
      ),
    );

    await act(async () => {
      scanner.props.onBarcodeScanned({ data: "5000112637922" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
  });

  test("a scan is ignored while one is already in flight", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const scanner = await findByTestId("barcode-scanner");

    await act(async () => {
      scanner.props.onBarcodeScanned({ data: "5000112637922" });
      scanner.props.onBarcodeScanned({ data: "4008400402222" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

    const [, firstOptions] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => firstOptions.onSuccess(resolutionFixture()));
    await waitFor(() => expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1));
  });
});
