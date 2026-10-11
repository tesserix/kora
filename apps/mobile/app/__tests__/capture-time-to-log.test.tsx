import { act, fireEvent, render as rtlRender, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import type { Resolution } from "@/api/types";

import CaptureScreen from "../capture";

// canGoBack/replace back safeBack(): capture is deep-link reachable (a
// notification tap), so it can mount with an empty stack and must not rely on a
// bare router.back(). Defaults to "there is history", the ordinary case.
jest.mock("expo-router", () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
}));

// Same shape as the real "@/lib/api" ApiError — see capture.test.tsx for why
// this is mocked instead of pulling in the real module under Jest.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "ApiError";
    }
  },
}));

const mockCaptureMessageMutate = jest.fn();
const mockResolvePhotoMutate = jest.fn();
const mockResolveVoiceMutate = jest.fn();
const mockResolveBarcodeMutate = jest.fn();
const mockCreateLogMutateAsync = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useAcceptMealPlan: () => ({ mutate: jest.fn(), isPending: false }),
  useCaptureMessage: () => ({ mutate: mockCaptureMessageMutate, isPending: false }),
  useResolvePhoto: () => ({ mutate: mockResolvePhotoMutate, isPending: false }),
  useResolveVoice: () => ({ mutate: mockResolveVoiceMutate, isPending: false }),
  useResolveBarcode: () => ({ mutate: mockResolveBarcodeMutate, isPending: false }),
  useCreateLog: () => ({ mutateAsync: mockCreateLogMutateAsync, isPending: false }),
  // The capture screen now mounts a FoodPicker for resolving uncertain rows.
  // Nothing here opens it, so an empty result set is enough — but the hook must
  // exist, or every render in this file throws before reaching its assertions.
  useFoodSearch: () => ({ data: [], isLoading: false, isError: false }),
}));

type MockRecorder = {
  prepareToRecordAsync: jest.Mock;
  record: jest.Mock;
  pause: jest.Mock;
  stop: jest.Mock;
  getStatus: jest.Mock;
  uri: string | null;
  isRecording: boolean;
  currentTime: number;
  id: string;
};

// A recorder whose `.stop()` populates `.uri` — mirrors the real AudioRecorder,
// where the URI is only available once the recording is flushed to disk.
function makeRecorder(): MockRecorder {
  const recorder: MockRecorder = {
    prepareToRecordAsync: jest.fn(async () => {}),
    record: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    getStatus: jest.fn(async () => ({ isRecording: false })),
    uri: null,
    isRecording: false,
    currentTime: 0,
    id: "mock-recorder",
  };
  recorder.stop = jest.fn(async () => {
    recorder.uri = "file://mock-recording.m4a";
  });
  return recorder;
}

// CaptureScreen now holds its own query client (useQueryClient, for
// invalidating the queued-captures view after an offline enqueue), so every
// render needs a provider in the tree.
function render(ui: React.ReactElement, options?: Parameters<typeof rtlRender>[1]) {
  const queryClient = new QueryClient();
  return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>, options);
}

function makeResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    candidates: [
      {
        item: {
          id: "1",
          name: "Grilled chicken breast",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 breast",
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
      },
    ],
    tier: "auto",
    is_estimate: false,
    provenance: "afcd",
    ...overrides,
  };
}

beforeEach(() => {
  mockCaptureMessageMutate.mockReset();
  mockResolvePhotoMutate.mockReset();
  mockResolveVoiceMutate.mockReset();
  mockResolveBarcodeMutate.mockReset();
  mockCreateLogMutateAsync.mockReset().mockResolvedValue({ id: "log-1" });
  (router.back as jest.Mock).mockReset();
  (router.push as jest.Mock).mockReset();
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.launchCameraAsync as jest.Mock).mockReset();
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReset();
  (requestRecordingPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true, status: "granted" });
  (useAudioRecorder as jest.Mock).mockReset().mockReturnValue(makeRecorder());
  (useCameraPermissions as jest.Mock).mockReset().mockReturnValue([
    { granted: true, status: "granted", canAskAgain: true, expires: "never" },
    jest.fn(async () => ({ granted: true, status: "granted" })),
    jest.fn(async () => ({ granted: true, status: "granted" })),
  ]);
});


// kora#482 / kora#43. `client_log_ms` is the north-star metric — "median
// time-to-log a meal (<10s target)" — and the column has existed since the
// original schema. Only app/log.tsx populated it, which is the MANUAL search
// path; production had 10 logs and zero timed, because every real log came
// through a capture path that never set it.

test("a capture log reports how long it took, measured from the capture", async () => {
  const started = 1_000_000;
  const nowSpy = jest.spyOn(Date, "now");
  // beginResolve() stamps the start; the confirm below reads the delta.
  nowSpy.mockReturnValue(started);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Type"));
  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "brekkie eggs");
  await fireEvent.press(await findByLabelText("Send"));

  const [, options] = mockCaptureMessageMutate.mock.calls[0];
  await act(async () => options.onSuccess({ kind: "resolution", resolution: makeResolution() }));

  // 4.2s later the user confirms.
  nowSpy.mockReturnValue(started + 4200);
  await fireEvent.press(await findByLabelText("Add to diary"));

  const [payload] = mockCreateLogMutateAsync.mock.calls[0];
  expect(payload.client_log_ms).toBe(4200);
  nowSpy.mockRestore();
});

// The reason this is measured at beginResolve rather than at screen mount,
// which is what app/log.tsx does: capture.tsx stays mounted across several
// logs, so mount time would charge the second meal for however long the user
// spent on the first.
test("a second capture is timed from ITS start, not from screen mount", async () => {
  const mounted = 2_000_000;
  const nowSpy = jest.spyOn(Date, "now");
  nowSpy.mockReturnValue(mounted);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);

  // First capture: starts 30s after mount, confirmed 2s later.
  await fireEvent.press(await findByText("Type"));
  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "brekkie eggs");
  nowSpy.mockReturnValue(mounted + 30_000);
  await fireEvent.press(await findByLabelText("Send"));
  const [, first] = mockCaptureMessageMutate.mock.calls[0];
  await act(async () => first.onSuccess({ kind: "resolution", resolution: makeResolution() }));
  nowSpy.mockReturnValue(mounted + 32_000);
  await fireEvent.press(await findByLabelText("Add to diary"));

  expect(mockCreateLogMutateAsync.mock.calls[0][0].client_log_ms).toBe(2_000);
  // Measured from mount it would have been 32,000 — the number this test exists
  // to rule out.
  expect(mockCreateLogMutateAsync.mock.calls[0][0].client_log_ms).not.toBe(32_000);
  nowSpy.mockRestore();
});
