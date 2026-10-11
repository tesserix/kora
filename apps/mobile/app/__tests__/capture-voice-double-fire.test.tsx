import { act, fireEvent, render as rtlRender } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";

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

test("one recording issues exactly one voice resolve when finish fires twice in a tick", async () => {
  const recorder = makeRecorder();
  (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Voice"));
  await fireEvent.press(await findByLabelText("Hold to record"));

  const stop = await findByLabelText("Stop recording");
  // Two finishes inside ONE tick, which is what the device produces: a single
  // hold-and-release reaches onFinish twice, because VoiceComposer nests a
  // Pressable inside the GestureDetector (deliberately -- hold-and-slide is
  // unusable under VoiceOver) and BOTH fire on release. The screen's guard was
  // `if (!isRecordingVoice) return`, and React state does not update within
  // the tick, so both calls passed it and both paid for a transcription.
  await act(async () => {
    fireEvent.press(stop);
    fireEvent.press(stop);
  });

  expect(mockResolveVoiceMutate).toHaveBeenCalledTimes(1);
});

test("a second recording still resolves after the first finished", async () => {
  const recorder = makeRecorder();
  (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Voice"));

  for (let i = 0; i < 2; i++) {
    await fireEvent.press(await findByLabelText("Hold to record"));
    await fireEvent.press(await findByLabelText("Stop recording"));
  }

  // The guard must suppress a duplicate finish, NOT latch the feature off.
  expect(mockResolveVoiceMutate).toHaveBeenCalledTimes(2);
});

test("cancelling twice in a tick never reaches the paid endpoint", async () => {
  const recorder = makeRecorder();
  (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Voice"));
  await fireEvent.press(await findByLabelText("Hold to record"));

  const cancel = await findByLabelText("Cancel recording");
  await act(async () => {
    fireEvent.press(cancel);
    fireEvent.press(cancel);
  });

  expect(mockResolveVoiceMutate).not.toHaveBeenCalled();
});
