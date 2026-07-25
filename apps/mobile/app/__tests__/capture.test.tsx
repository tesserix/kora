import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { router } from "expo-router";
import { ApiError } from "@/lib/api";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

// The real "@/lib/api" pulls in "@/lib/firebase" -> AsyncStorage's native
// module, which isn't available under Jest. Mock it with a same-shape
// ApiError so `instanceof ApiError` narrowing in capture.tsx still works.
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

const mockResolveTextMutate = jest.fn();
const mockResolvePhotoMutate = jest.fn();
const mockResolveVoiceMutate = jest.fn();
const mockResolveBarcodeMutate = jest.fn();
const mockCreateLogMutateAsync = jest.fn();
let mockResolveTextIsPending = false;
let mockResolvePhotoIsPending = false;
let mockResolveVoiceIsPending = false;
let mockResolveBarcodeIsPending = false;

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => ({
    mutate: mockResolveTextMutate,
    get isPending() {
      return mockResolveTextIsPending;
    },
  }),
  useResolvePhoto: () => ({
    mutate: mockResolvePhotoMutate,
    get isPending() {
      return mockResolvePhotoIsPending;
    },
  }),
  useResolveVoice: () => ({
    mutate: mockResolveVoiceMutate,
    get isPending() {
      return mockResolveVoiceIsPending;
    },
  }),
  useResolveBarcode: () => ({
    mutate: mockResolveBarcodeMutate,
    get isPending() {
      return mockResolveBarcodeIsPending;
    },
  }),
  useCreateLog: () => ({
    mutateAsync: mockCreateLogMutateAsync,
    isPending: false,
  }),
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

import CaptureScreen, { CaptureBody, sourceForMode } from "../capture";

function makeResolution(): Resolution {
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
  };
}

function makeCandidate(id: string, name: string, gramsAndKcal: { grams: number; kcal: number }): Resolution["candidates"][number] {
  return {
    item: {
      id,
      name,
      brand: "",
      provenance: "afcd",
      serving_desc: "1 serving",
      serving_grams: gramsAndKcal.grams,
      kcal_per_100g: 100,
      protein_per_100g: 10,
      carbs_per_100g: 10,
      fat_per_100g: 5,
    },
    portion_grams: gramsAndKcal.grams,
    kcal: gramsAndKcal.kcal,
    match_score: 0.9,
    match_tier: "auto",
  };
}

function makeMultiCandidateResolution(): Resolution {
  return {
    candidates: [
      makeCandidate("1", "Grilled chicken breast", { grams: 140, kcal: 231 }),
      makeCandidate("2", "Steamed broccoli", { grams: 90, kcal: 32 }),
      makeCandidate("3", "Brown rice", { grams: 150, kcal: 165 }),
    ],
    tier: "confirm",
    is_estimate: false,
    provenance: "afcd",
  };
}

function makeFollowUpResolution(): Resolution {
  return {
    candidates: [],
    tier: "follow_up",
    follow_up_question: "Was that grilled or fried chicken?",
    is_estimate: false,
    provenance: "afcd",
  };
}

function makeEmptyResolution(): Resolution {
  return {
    candidates: [],
    tier: "confirm",
    is_estimate: false,
    provenance: "afcd",
  };
}

function makeEstimateResolution(): Resolution {
  return {
    candidates: [makeCandidate("9", "Mystery stew", { grams: 300, kcal: 420 })],
    tier: "confirm",
    is_estimate: true,
    kcal_low: 350,
    kcal_high: 500,
    provenance: "afcd",
  };
}

const noopBodyProps = {
  displayName: "Alex",
  insetTop: 0,
  insetBottom: 0,
  mode: "photo" as const,
  onModeChange: jest.fn(),
  errorMsg: null,
  mealSlot: "lunch" as const,
  onChangeMealSlot: jest.fn(),
  onAdd: jest.fn(),
  adding: false,
  onSearchManually: jest.fn(),
  text: "",
  onChangeText: jest.fn(),
  onSend: jest.fn(),
  onCapturePhoto: jest.fn(),
  isRecordingVoice: false,
  onToggleVoice: jest.fn(),
  cameraPermissionGranted: true,
  onBarcodeScanned: jest.fn(),
  onClose: jest.fn(),
};

beforeEach(() => {
  mockResolveTextMutate.mockReset();
  mockResolvePhotoMutate.mockReset();
  mockResolveVoiceMutate.mockReset();
  mockResolveBarcodeMutate.mockReset();
  mockCreateLogMutateAsync.mockReset().mockResolvedValue({ id: "log-1" });
  (router.back as jest.Mock).mockReset();
  (router.push as jest.Mock).mockReset();
  mockResolveTextIsPending = false;
  mockResolvePhotoIsPending = false;
  mockResolveVoiceIsPending = false;
  mockResolveBarcodeIsPending = false;
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

test("renders the Otto greeting and all four mode pills", async () => {
  const { findByText } = await render(<CaptureScreen />);
  expect(await findByText(/show me your meal/i)).toBeTruthy();
  expect(await findByText("Photo")).toBeTruthy();
  expect(await findByText("Voice")).toBeTruthy();
  expect(await findByText("Scan")).toBeTruthy();
  expect(await findByText("Type")).toBeTruthy();
});

test("tapping a mode pill switches mode and changes the idle affordance", async () => {
  const { findByText, findByTestId, getByTestId, queryByTestId } = await render(<CaptureScreen />);
  expect(getByTestId("capture-idle-photo")).toBeTruthy();

  fireEvent.press(await findByText("Voice"));
  expect(await findByTestId("capture-idle-voice")).toBeTruthy();
  expect(queryByTestId("capture-idle-photo")).toBeNull();

  fireEvent.press(await findByText("Scan"));
  expect(await findByTestId("capture-idle-scan")).toBeTruthy();
  expect(queryByTestId("capture-idle-voice")).toBeNull();

  fireEvent.press(await findByText("Type"));
  expect(await findByTestId("capture-idle-type")).toBeTruthy();
  expect(queryByTestId("capture-idle-scan")).toBeNull();
});

test("analyzing stage shows the spinner", async () => {
  const { getByTestId } = await render(
    <CaptureBody {...noopBodyProps} stage="analyzing" resolution={null} />,
  );
  expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
});

test("result stage renders DetectedCard when resolution is set", async () => {
  const resolution = makeResolution();
  const { getByText } = await render(
    <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
  );
  expect(getByText(/Detected · 1 items/i)).toBeTruthy();
  expect(getByText("Grilled chicken breast")).toBeTruthy();
  expect(getByText(/I found 1 item, about 231 kcal/i)).toBeTruthy();
});

test("idle stage does not render the analyzing spinner or a result card", async () => {
  const { queryByTestId, queryByText } = await render(
    <CaptureBody {...noopBodyProps} stage="idle" resolution={null} />,
  );
  expect(queryByTestId("capture-analyzing-spinner")).toBeNull();
  expect(queryByText(/Detected ·/i)).toBeNull();
});

test("error message renders as an Otto bubble", async () => {
  const { getByText } = await render(
    <CaptureBody {...noopBodyProps} stage="idle" resolution={null} errorMsg="I need camera or photo access to see your meal." />,
  );
  expect(getByText("I need camera or photo access to see your meal.")).toBeTruthy();
});

describe("Type mode", () => {
  test("typing and pressing send calls useResolveText with the phrase", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "grilled chicken and rice");
    await fireEvent.press(await findByLabelText("Send"));

    expect(mockResolveTextMutate).toHaveBeenCalledWith(
      "grilled chicken and rice",
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  test("empty input does not call useResolveText", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));
    await fireEvent.press(await findByLabelText("Send"));
    expect(mockResolveTextMutate).not.toHaveBeenCalled();
  });

  test("whitespace-only input keeps the send button disabled and inactive-colored", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "   ");

    const sendButton = await findByLabelText("Send");
    expect(sendButton.props.accessibilityState).toEqual({ disabled: true });
    expect(sendButton.props.style.backgroundColor).toBe("rgba(255,255,255,0.15)");

    await fireEvent.press(sendButton);
    expect(mockResolveTextMutate).not.toHaveBeenCalled();
  });

  test("a successful resolve renders the DetectedCard", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "grilled chicken and rice");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    expect(await findByText("Grilled chicken breast")).toBeTruthy();
  });

  test("a failed resolve renders the Otto error bubble", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "mystery mush");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new ApiError(422, "no_match", "no confident match")));

    expect(await findByText(/no confident match/i)).toBeTruthy();
  });

  test("shows the analyzing stage while the text resolve is pending", async () => {
    mockResolveTextIsPending = true;
    const { getByTestId } = await render(<CaptureScreen />);
    expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
  });
});

describe("Photo mode", () => {
  test("a captured photo triggers useResolvePhoto with the file", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });

    const { findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    await waitFor(() =>
      expect(mockResolvePhotoMutate).toHaveBeenCalledWith(
        { uri: "file://x.jpg", name: "x.jpg", type: "image/jpeg" },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      ),
    );
  });

  test("a canceled picker does not call useResolvePhoto", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({ canceled: true, assets: null });

    const { findByLabelText, queryByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    await waitFor(() => expect(ImagePicker.launchCameraAsync).toHaveBeenCalledTimes(1));
    expect(mockResolvePhotoMutate).not.toHaveBeenCalled();
    expect(queryByText(/camera or photo access/i)).toBeNull();
  });

  test("denied camera and library permissions render the Otto error bubble", async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });

    const { findByLabelText, findByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    expect(await findByText("I need camera or photo access to see your meal.")).toBeTruthy();
    expect(mockResolvePhotoMutate).not.toHaveBeenCalled();
  });

  test("a successful photo resolve renders the DetectedCard", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });

    const { findByLabelText, findByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    expect(await findByText("Grilled chicken breast")).toBeTruthy();
  });

  test("shows the analyzing stage while the photo resolve is pending", async () => {
    mockResolvePhotoIsPending = true;
    const { getByTestId } = await render(<CaptureScreen />);
    expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
  });

  test("camera denied falls back to the library and still resolves the picked asset", async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://library.jpg", fileName: "library.jpg", mimeType: "image/jpeg" }],
    });

    const { findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    await waitFor(() =>
      expect(mockResolvePhotoMutate).toHaveBeenCalledWith(
        { uri: "file://library.jpg", name: "library.jpg", type: "image/jpeg" },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      ),
    );
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  test("the composer's Quick photo capture button triggers the same photo flow", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://quick.jpg", fileName: "quick.jpg", mimeType: "image/jpeg" }],
    });

    const { findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Quick photo capture"));

    await waitFor(() =>
      expect(mockResolvePhotoMutate).toHaveBeenCalledWith(
        { uri: "file://quick.jpg", name: "quick.jpg", type: "image/jpeg" },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      ),
    );
  });

  test("an unexpected picker failure still renders an Otto error bubble (no silent failure)", async () => {
    (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
    (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockRejectedValueOnce(new Error("native crash"));

    const { findByLabelText, findByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByLabelText("Photo viewfinder"));

    expect(await findByText("Something went wrong opening your photos — try again.")).toBeTruthy();
    expect(mockResolvePhotoMutate).not.toHaveBeenCalled();
  });
});

describe("Voice mode", () => {
  test("start then stop recording calls useResolveVoice with the recorded file", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));

    await fireEvent.press(await findByLabelText("Start recording"));
    expect(recorder.prepareToRecordAsync).toHaveBeenCalled();
    expect(recorder.record).toHaveBeenCalled();

    await fireEvent.press(await findByLabelText("Stop recording"));

    await waitFor(() =>
      expect(mockResolveVoiceMutate).toHaveBeenCalledWith(
        { uri: "file://mock-recording.m4a", name: "clip.m4a", type: "audio/mp4" },
        expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
      ),
    );
  });

  test("denied mic permission renders the Otto error bubble and never starts recording", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);
    (requestRecordingPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false, status: "denied" });

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Start recording"));

    expect(await findByText(/i need mic access/i)).toBeTruthy();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(mockResolveVoiceMutate).not.toHaveBeenCalled();
  });

  test("a successful voice resolve renders the DetectedCard", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Start recording"));
    await fireEvent.press(await findByLabelText("Stop recording"));

    await waitFor(() => expect(mockResolveVoiceMutate).toHaveBeenCalled());
    const [, options] = mockResolveVoiceMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    expect(await findByText("Grilled chicken breast")).toBeTruthy();
  });

  test("a failed voice resolve renders the Otto error bubble", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Start recording"));
    await fireEvent.press(await findByLabelText("Stop recording"));

    await waitFor(() => expect(mockResolveVoiceMutate).toHaveBeenCalled());
    const [, options] = mockResolveVoiceMutate.mock.calls[0];
    await act(async () => options.onError(new ApiError(422, "no_match", "couldn't make that out")));

    expect(await findByText(/couldn't make that out/i)).toBeTruthy();
  });

  test("shows the analyzing stage while the voice resolve is pending", async () => {
    mockResolveVoiceIsPending = true;
    const { getByTestId } = await render(<CaptureScreen />);
    expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
  });

  test("switching mode away while recording stops the recorder and resets the mic button", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText, queryByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Start recording"));
    expect(await findByLabelText("Stop recording")).toBeTruthy();

    await fireEvent.press(await findByText("Type"));

    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
    expect(mockResolveVoiceMutate).not.toHaveBeenCalled();

    await fireEvent.press(await findByText("Voice"));
    expect(await findByLabelText("Start recording")).toBeTruthy();
    expect(queryByLabelText("Stop recording")).toBeNull();
  });

  test("unmounting the screen while recording stops the recorder", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText, unmount } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Start recording"));

    unmount();

    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
  });
});

describe("Scan mode", () => {
  test("a scanned barcode calls useResolveBarcode with the scanned data", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));

    const cameraView = await findByTestId("capture-camera-view");
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });

    expect(mockResolveBarcodeMutate).toHaveBeenCalledWith(
      "012345678905",
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  test("a duplicate rapid scan only calls useResolveBarcode once", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));

    const cameraView = await findByTestId("capture-camera-view");
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });

    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);
  });

  test("denied camera permission renders the Otto error bubble", async () => {
    const deniedRequest = jest.fn(async () => ({ granted: false, status: "denied" }));
    (useCameraPermissions as jest.Mock).mockReturnValue([
      { granted: false, status: "denied", canAskAgain: true, expires: "never" },
      deniedRequest,
      jest.fn(),
    ]);

    const { findByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));

    expect(await findByText(/i need camera access/i)).toBeTruthy();
    expect(mockResolveBarcodeMutate).not.toHaveBeenCalled();
  });

  test("a successful barcode resolve renders the DetectedCard", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));

    const cameraView = await findByTestId("capture-camera-view");
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });

    await waitFor(() => expect(mockResolveBarcodeMutate).toHaveBeenCalled());
    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    expect(await findByText("Grilled chicken breast")).toBeTruthy();
  });

  test("shows the analyzing stage while the barcode resolve is pending", async () => {
    mockResolveBarcodeIsPending = true;
    const { getByTestId } = await render(<CaptureScreen />);
    expect(getByTestId("capture-analyzing-spinner")).toBeTruthy();
  });
});

describe("Result tiers", () => {
  test("a 'confirm' tier renders DetectedCard the same as 'auto'", async () => {
    const resolution = makeMultiCandidateResolution();
    const { getByText } = await render(
      <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
    );
    expect(getByText(/Detected · 3 items/i)).toBeTruthy();
    expect(getByText(/I found 3 items, about 428 kcal/i)).toBeTruthy();
  });

  test("an is_estimate resolution shows the kcal range in the Otto summary", async () => {
    const resolution = makeEstimateResolution();
    const { getByText } = await render(
      <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
    );
    expect(getByText(/I found 1 item, about 350–500 kcal/i)).toBeTruthy();
  });

  test("a follow_up tier renders the question and a Search manually link, no DetectedCard", async () => {
    const resolution = makeFollowUpResolution();
    const { getByText, queryByText, getByLabelText } = await render(
      <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
    );
    expect(getByText("Was that grilled or fried chicken?")).toBeTruthy();
    expect(getByLabelText("Search manually")).toBeTruthy();
    expect(queryByText(/Detected ·/i)).toBeNull();
  });

  test("pressing Search manually navigates to /log", async () => {
    const resolution = makeFollowUpResolution();
    const onSearchManually = jest.fn();
    const { findByLabelText } = await render(
      <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} onSearchManually={onSearchManually} />,
    );
    await fireEvent.press(await findByLabelText("Search manually"));
    expect(onSearchManually).toHaveBeenCalled();
  });

  test("the real screen's Search manually link calls router.push('/log')", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));
    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "a mystery bowl");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeFollowUpResolution()));

    await fireEvent.press(await findByLabelText("Search manually"));
    expect(router.push).toHaveBeenCalledWith("/log");
  });

  test("empty candidates with no follow_up_question renders the generic couldn't-identify message and a link", async () => {
    const resolution = makeEmptyResolution();
    const { getByText, getByLabelText, queryByText } = await render(
      <CaptureBody {...noopBodyProps} stage="result" resolution={resolution} />,
    );
    expect(getByText(/I couldn't identify that/i)).toBeTruthy();
    expect(getByLabelText("Search manually")).toBeTruthy();
    expect(queryByText(/Detected ·/i)).toBeNull();
  });
});

describe("Add to diary", () => {
  async function resolveWithMultiCandidates(rendered: Awaited<ReturnType<typeof render>>) {
    const { findByText, findByLabelText } = rendered;
    await fireEvent.press(await findByText("Type"));
    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "big breakfast");
    await fireEvent.press(await findByLabelText("Send"));
    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeMultiCandidateResolution()));
  }

  test("logs each candidate with the correct food_item_id/grams/meal_slot/source, then navigates back", async () => {
    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered);

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(3));

    const calls = mockCreateLogMutateAsync.mock.calls.map(([input]) => input);
    expect(calls[0]).toEqual(
      expect.objectContaining({ food_item_id: "1", quantity_grams: 140, source: "ai_text", logged_at: expect.any(String) }),
    );
    expect(calls[1]).toEqual(
      expect.objectContaining({ food_item_id: "2", quantity_grams: 90, source: "ai_text", logged_at: expect.any(String) }),
    );
    expect(calls[2]).toEqual(
      expect.objectContaining({ food_item_id: "3", quantity_grams: 150, source: "ai_text", logged_at: expect.any(String) }),
    );
    for (const call of calls) {
      expect(["breakfast", "lunch", "dinner", "snack"]).toContain(call.meal_slot);
    }

    await waitFor(() => expect(router.back).toHaveBeenCalled());
  });

  test("a createLog failure surfaces an Otto error bubble and does not navigate back", async () => {
    mockCreateLogMutateAsync
      .mockResolvedValueOnce({ id: "log-1" })
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ id: "log-3" });

    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered);

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    expect(await rendered.findByText(/couldn't log Steamed broccoli/i)).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
  });

  test("retrying after a partial failure only re-logs the previously-failed candidate, not the succeeded ones", async () => {
    mockCreateLogMutateAsync
      .mockResolvedValueOnce({ id: "log-1" })
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ id: "log-3" });

    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered);

    // First press: candidate 2 (Steamed broccoli) fails, 1 and 3 succeed.
    await fireEvent.press(await rendered.findByLabelText("Add to diary"));
    expect(await rendered.findByText(/couldn't log Steamed broccoli/i)).toBeTruthy();
    expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(3);
    expect(router.back).not.toHaveBeenCalled();

    mockCreateLogMutateAsync.mockClear();
    mockCreateLogMutateAsync.mockResolvedValueOnce({ id: "log-2-retry" });

    // Second press: only the previously-failed candidate should be re-submitted.
    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ food_item_id: "2", quantity_grams: 90, source: "ai_text" }),
    );

    await waitFor(() => expect(router.back).toHaveBeenCalled());
  });
});

test("switching mode clears a stale error bubble", async () => {
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });

  const { findByLabelText, findByText, queryByText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByLabelText("Photo viewfinder"));
  expect(await findByText("I need camera or photo access to see your meal.")).toBeTruthy();

  await fireEvent.press(await findByText("Type"));
  expect(queryByText("I need camera or photo access to see your meal.")).toBeNull();
});

describe("sourceForMode", () => {
  test.each([
    ["photo", "ai_photo"],
    ["voice", "ai_voice"],
    ["scan", "ai_barcode"],
    ["type", "ai_text"],
  ] as const)("%s -> %s", (mode, expected) => {
    expect(sourceForMode(mode)).toBe(expected);
  });
});
