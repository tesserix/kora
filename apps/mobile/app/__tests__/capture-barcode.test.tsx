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
// Mutable so the Cancel tests below can force the analyzing stage (and its
// Cancel control) to render without a real pending mutation — mirrors the
// mockResolveTextIsPending getter pattern in capture.test.tsx.
let mockResolveBarcodeIsPending = false;

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
    get isPending() {
      return mockResolveBarcodeIsPending;
    },
  }),
  useCreateLog: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

import CaptureScreen from "../capture";

async function render(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Like `render`, but also returns `rerenderSame`, bound to the same element —
// needed by the cooldown tests below, which flip the mutable
// mockResolveBarcodeIsPending flag mid-test and must force CaptureScreen to
// re-evaluate displayStage against the new value (the mock hook isn't real
// React state, so nothing re-renders on its own when the flag changes).
// Deliberately returns `utils` untouched alongside the new helper rather than
// merging them into one object — RTL's render result turned out not to
// accept extra own properties (an Object.assign onto it silently no-ops).
async function renderCapture() {
  const queryClient = new QueryClient();
  // A fresh element each call — `rerenderSame` below passes a brand new JSX
  // element referencing the same queryClient, not the original object
  // reference, because RNTL's renderer only re-invokes CaptureScreen when it
  // sees a new element identity; re-rendering the literal cached element was
  // silently a no-op and left the mocked isPending flip unobserved.
  const buildElement = () => (
    <QueryClientProvider client={queryClient}>
      <CaptureScreen />
    </QueryClientProvider>
  );
  // rtlRender is itself async — the other helper (`render` above) gets away
  // with returning the un-awaited promise because returning a promise from
  // an async function auto-adopts it, so `await render(...)` still resolves
  // to the real result. Wrapping it in `{ utils, rerenderSame }` below
  // defeats that auto-adoption (a promise nested inside a plain object is
  // not unwrapped), so it must be awaited explicitly here.
  const utils = await rtlRender(buildElement());
  return { utils, rerenderSame: () => utils.rerender(buildElement()) };
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
  mockResolveBarcodeIsPending = false;
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

// Cancel (#136 part 2) makes the resolve genuinely abort, which means
// onError now fires at once and releases scannedRef immediately — with the
// cancelled code still in frame, firing onBarcodeScanned dozens of times a
// second. These three tests pin the cooldown that stops the cancelled code
// from re-firing on its own, while leaving a *different* code free to scan
// right away.
//
// Drives a scan through to a pressable Cancel: scans `data` on the current
// (idle-stage) scanner, then flips the mocked isPending flag on and forces a
// re-render so CaptureBody actually switches to the analyzing stage — the
// mock hook has no real pending state of its own, so nothing does this
// automatically the way a real mutation would. Returns the mutate() options
// for the in-flight call so the caller can complete it.
async function scanThenReachCancel(
  render: Awaited<ReturnType<typeof renderCapture>>,
  data: string,
): Promise<{ onError: (error: unknown) => void; onSuccess: (result: unknown) => void }> {
  const { utils, rerenderSame } = render;
  const scanner = await utils.findByTestId("barcode-scanner");
  await act(async () => {
    scanner.props.onBarcodeScanned({ data });
  });
  mockResolveBarcodeIsPending = true;
  await act(async () => rerenderSame());
  await utils.findByLabelText("Cancel");
  const [, options] = mockResolveBarcodeMutate.mock.calls[mockResolveBarcodeMutate.mock.calls.length - 1];
  return options;
}

describe("barcode scanner cooldown after Cancel", () => {
  test("a different barcode scans immediately after a cancel", async () => {
    const render = await renderCapture();
    const { utils, rerenderSame } = render;
    await fireEvent.press(await utils.findByText("Scan"));

    const options = await scanThenReachCancel(render, "5000112637922");
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

    await fireEvent.press(await utils.findByLabelText("Cancel"));
    // Mirrors Task 1: the abort makes onError fire immediately, which is
    // what releases scannedRef with the cancelled code still in frame.
    await act(async () => options.onError(new DOMException("Aborted", "AbortError")));
    mockResolveBarcodeIsPending = false;
    await act(async () => rerenderSame());

    const scannerAgain = await utils.findByTestId("barcode-scanner");
    await act(async () => {
      scannerAgain.props.onBarcodeScanned({ data: "4008400402222" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
  });

  test("re-presenting the cancelled barcode within the cooldown does not start a new resolve", async () => {
    const render = await renderCapture();
    const { utils, rerenderSame } = render;
    await fireEvent.press(await utils.findByText("Scan"));

    const options = await scanThenReachCancel(render, "5000112637922");
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

    await fireEvent.press(await utils.findByLabelText("Cancel"));
    await act(async () => options.onError(new DOMException("Aborted", "AbortError")));
    mockResolveBarcodeIsPending = false;
    await act(async () => rerenderSame());

    // Same code, still in frame — CameraView firing again immediately, as
    // it does dozens of times a second while a code is detected.
    const scannerAgain = await utils.findByTestId("barcode-scanner");
    await act(async () => {
      scannerAgain.props.onBarcodeScanned({ data: "5000112637922" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);
  });

  test("the same barcode scans again once the cooldown has elapsed", async () => {
    jest.useFakeTimers();
    try {
      const render = await renderCapture();
      const { utils, rerenderSame } = render;
      await fireEvent.press(await utils.findByText("Scan"));

      const options = await scanThenReachCancel(render, "5000112637922");
      expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

      await fireEvent.press(await utils.findByLabelText("Cancel"));
      await act(async () => options.onError(new DOMException("Aborted", "AbortError")));
      mockResolveBarcodeIsPending = false;
      await act(async () => rerenderSame());

      await act(async () => {
        jest.advanceTimersByTime(2001);
      });

      const scannerAgain = await utils.findByTestId("barcode-scanner");
      await act(async () => {
        scannerAgain.props.onBarcodeScanned({ data: "5000112637922" });
      });
      expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
