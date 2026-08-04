import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import { router } from "expo-router";
import { ApiError, AuthTokenError, NetworkError, ResponseParseError } from "@/lib/api";
import type { FoodItem, Resolution } from "@/api/types";
import { OfflineUnknownBarcodeError, resolutionFromCachedFood } from "@/offline/cachedResolution";

const cachedBarcodeFood: FoodItem = {
  id: "f-bar",
  name: "Choc protein bar",
  brand: "Kora",
  provenance: "openfoodfacts",
  serving_desc: "1 bar (60 g)",
  serving_grams: 60,
  kcal_per_100g: 400,
  protein_per_100g: 30,
  carbs_per_100g: 40,
  fat_per_100g: 12,
  barcode: "012345678905",
};

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

// The real "@/lib/api" pulls in "@/lib/firebase" -> AsyncStorage's native
// module, which isn't available under Jest. Mock it with same-shape classes
// so the `instanceof` narrowing in capture.tsx's ottoErrorMessage still works
// for all four error types it distinguishes.
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId?: string;
    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.name = "ApiError";
    }
  },
  AuthTokenError: class AuthTokenError extends Error {
    constructor(cause?: unknown) {
      super("Failed to obtain an auth token", { cause });
      this.name = "AuthTokenError";
    }
  },
  NetworkError: class NetworkError extends Error {
    constructor(cause?: unknown) {
      super("Network request failed", { cause });
      this.name = "NetworkError";
    }
  },
  ResponseParseError: class ResponseParseError extends Error {
    constructor(cause?: unknown) {
      super("Failed to parse response body", { cause });
      this.name = "ResponseParseError";
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
  // FoodPicker (opened from an uncertain row) searches the free food index.
  // Shape mirrors the real useFoodSearch: a Candidate[] under `data`, which
  // FoodPicker renders one row per, keyed and labelled by `item`.
  useFoodSearch: () => ({
    data: [
      {
        item: {
          id: "picked",
          name: "White rice, cooked",
          brand: "",
          provenance: "afcd",
          serving_desc: "1 cup",
          serving_grams: 150,
          kcal_per_100g: 130,
          protein_per_100g: 2.7,
          carbs_per_100g: 28,
          fat_per_100g: 0.3,
        },
        match_score: 0.9,
        match_tier: "full_text",
      },
    ],
    isLoading: false,
    isError: false,
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

import CaptureScreen, { CaptureBody } from "../capture";

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

// Drives a real text capture through to a rendered result. Callers pass the
// resolution the server "returns"; the mutate mock records its options object
// and we invoke onSuccess by hand, exactly as the neighbouring tests do.
async function resolveWithMultiCandidates(
  rendered: Awaited<ReturnType<typeof render>>,
  resolution: Resolution = makeMultiCandidateResolution(),
  callIndex = 0,
) {
  const { findByText, findByLabelText } = rendered;
  await fireEvent.press(await findByText("Type"));
  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "big breakfast");
  await fireEvent.press(await findByLabelText("Send"));
  const [, options] = mockResolveTextMutate.mock.calls[callIndex];
  await act(async () => options.onSuccess(resolution));
}

// Two candidates, one of which the server flagged as follow_up. The card
// already refuses to count it; the batch must refuse to log it, otherwise a
// guess the user never confirmed lands in the diary as a real entry.
function makeMixedCertaintyResolution(): Resolution {
  return {
    ...makeMultiCandidateResolution(),
    candidates: [
      { ...makeCandidate("a", "Grilled chicken breast", { grams: 170, kcal: 281 }), tier: "auto" },
      { ...makeCandidate("b", "Rice dish", { grams: 200, kcal: 260 }), tier: "follow_up" },
    ],
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
  onStartVoice: jest.fn(),
  onFinishVoice: jest.fn(),
  onCancelVoice: jest.fn(),
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

  test("a network failure renders copy about not reaching the server, not the generic fallback", async () => {
    const { findByText, findByLabelText, queryByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "mystery mush");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new NetworkError(new TypeError("Network request failed"))));

    expect(await findByText(/reach/i)).toBeTruthy();
    expect(
      queryByText("Something went wrong while I looked at that. Please try again."),
    ).toBeNull();
  });

  test("a response-parse failure renders copy about not understanding the answer, not the generic fallback", async () => {
    const { findByText, findByLabelText, queryByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "mystery mush");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new ResponseParseError(new SyntaxError("bad json"))));

    expect(await findByText(/couldn't make sense/i)).toBeTruthy();
    expect(
      queryByText("Something went wrong while I looked at that. Please try again."),
    ).toBeNull();
  });

  test("an auth-token failure renders its own copy, distinct from network and parse failures", async () => {
    const { findByText, findByLabelText, queryByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "mystery mush");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new AuthTokenError(new Error("token unavailable"))));

    // Asserts the property this test is named for — a distinct, non-generic
    // message — rather than one specific phrase. The earlier version matched
    // /sign(ing|ed)? in/, which coupled it to copy that told the user to
    // sign in again; that advice was wrong (this error usually means a
    // dropped connection, not an unusable session) and the assertion broke
    // the moment the copy was corrected. Wording is not the contract here.
    expect(await findByText(/session/i)).toBeTruthy();
    expect(
      queryByText("Something went wrong while I looked at that. Please try again."),
    ).toBeNull();
    expect(queryByText(/couldn't reach the server/i)).toBeNull();
    expect(queryByText(/couldn't make sense of it/i)).toBeNull();
  });

  test("an unrecognised error still falls back to the generic message", async () => {
    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Type"));

    const input = await findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "mystery mush");
    await fireEvent.press(await findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onError(new Error("totally unrelated failure")));

    expect(
      await findByText("Something went wrong while I looked at that. Please try again."),
    ).toBeTruthy();
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

    await fireEvent.press(await findByLabelText("Hold to record"));
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
    await fireEvent.press(await findByLabelText("Hold to record"));

    expect(await findByText(/i need mic access/i)).toBeTruthy();
    expect(recorder.record).not.toHaveBeenCalled();
    expect(mockResolveVoiceMutate).not.toHaveBeenCalled();
  });

  test("a successful voice resolve renders the DetectedCard", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Hold to record"));
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
    await fireEvent.press(await findByLabelText("Hold to record"));
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
    await fireEvent.press(await findByLabelText("Hold to record"));
    expect(await findByLabelText("Stop recording")).toBeTruthy();

    await fireEvent.press(await findByText("Type"));

    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
    expect(mockResolveVoiceMutate).not.toHaveBeenCalled();

    await fireEvent.press(await findByText("Voice"));
    expect(await findByLabelText("Hold to record")).toBeTruthy();
    expect(queryByLabelText("Stop recording")).toBeNull();
  });

  test("unmounting the screen while recording stops the recorder", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText, unmount } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Hold to record"));

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

  // --- Offline barcode fallback -------------------------------------------
  //
  // The hook-level tests in src/api/__tests__/hooks.test.tsx own the fallback
  // LOGIC (with onlineManager genuinely offline). These own the COPY: a cache
  // hit and a fresh AI resolve must not read the same, and a cache miss while
  // offline must not read as "this food does not exist".

  test("a barcode answered from the offline cache says so, instead of posing as a fresh resolve", async () => {
    const { findByText, findAllByText, findByTestId, queryByText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const cameraView = await findByTestId("capture-camera-view");

    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });
    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    // Built by the real adapter, so this test breaks if the shape it produces
    // stops being the shape the screen can recognise.
    await act(async () => options.onSuccess(resolutionFromCachedFood(cachedBarcodeFood)));

    const bubble = await findByText(/from a scan you.{0,3}ve done before/i);
    expect(bubble).toBeTruthy();
    // It must NOT promise a future calorie fill-in. useQueuedLogs.toRow derives
    // the kcal from the very same cached record a second later and counts it in
    // the day total, so "once you're back online" describes an event that has
    // already happened by the time the user reaches the diary.
    expect(bubble.props.children).not.toMatch(/back online/i);
    expect(bubble.props.children).not.toMatch(/fill in the calories/i);
    // Still a normal, loggable result card — the food is named and confirmable.
    expect(await findByText("Choc protein bar")).toBeTruthy();
    // And it must not claim a calorie figure it does not have — in the row OR
    // in the card's running total, which used to sum an empty set to "0 kcal".
    expect(await findAllByText("\u2014")).toHaveLength(2);
    expect(queryByText("0 kcal")).toBeNull();
  });

  test("an unscanned barcode offline explains why, and leaves the scanner usable", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const cameraView = await findByTestId("capture-camera-view");

    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "999999999999", type: "ean13" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => options.onError(new OfflineUnknownBarcodeError()));

    // Not "I couldn't identify that — try again", which is advice that cannot
    // work until the network returns.
    const bubble = await findByText(/offline/i);
    expect(bubble).toBeTruthy();
    expect(bubble.props.children).not.toMatch(/couldn.{0,3}t identify/i);

    // The guard released, so the user can scan something else.
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "888888888888", type: "ean13" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
  });

  // The scanner is guarded by a one-shot ref so one physical barcode does not
  // fire the resolve repeatedly. A resolve that FAILS has to release that
  // guard, or the viewfinder is dead for the rest of the session — the user
  // sees the error and can do nothing about it. This matters more now that
  // mutations reject offline instead of hanging in "analyzing" forever (see
  // src/lib/queryClient), because failing is the common offline outcome.
  test("a failed barcode resolve releases the scanner so the user can scan again", async () => {
    const { findByText, findByTestId } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));
    const cameraView = await findByTestId("capture-camera-view");

    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(1);

    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => options.onError(new Error("boom")));
    expect(await findByText(/something went wrong while i looked at that/i)).toBeTruthy();

    // The same code again: without the reset this second scan is swallowed by
    // the guard and the count stays at 1.
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });
    expect(mockResolveBarcodeMutate).toHaveBeenCalledTimes(2);
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

  test("adding to diary skips items the card marked uncertain", async () => {
    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered, makeMixedCertaintyResolution());

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ food_item_id: "a", quantity_grams: 170 }),
    );
  });

  test("a failure message counts the loggable items, not the detected ones", async () => {
    mockCreateLogMutateAsync.mockReset().mockRejectedValue(new Error("network error"));

    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered, makeMixedCertaintyResolution());

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    // One of one loggable item failed — the uncertain second row was never a
    // candidate for the diary, so counting it here would misreport the batch.
    expect(await rendered.findByText(/I logged 0 of 1 items/i)).toBeTruthy();
  });

  test("an all-uncertain resolution logs nothing and never starts the spinner", async () => {
    const base = makeMultiCandidateResolution();
    const allUncertain: Resolution = {
      ...base,
      candidates: base.candidates.map((candidate) => ({ ...candidate, tier: "follow_up" as const })),
    };

    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered, allUncertain);

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    expect(mockCreateLogMutateAsync).not.toHaveBeenCalled();
    expect(rendered.queryByTestId("detected-card-adding-spinner")).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
  });
});

// `source` must record which modality actually resolved the food, not which
// capture tab happened to be open — the composer ("Tell Otto what you ate")
// and the "Quick photo capture" shortcut are both rendered on every tab, so
// a user can type or snap a photo while a *different* tab is active, and the
// log must still read the modality that actually ran.
//
// Not every test below can catch a regression to reading `source` off
// `mode` — only the ones where `mode` and the resolve it drives disagree.
// Three do:
//   - "typing on the Photo tab" — mode stays "photo" (its default), the
//     resolve is text; a mode-derived source would read "ai_photo".
//   - "a photo capture via the quick-capture shortcut, from the Type tab" —
//     mode is switched to "type" first, the resolve is a photo; a
//     mode-derived source would read "ai_text".
//   - "last-resolve-wins" — mode stays "photo" throughout (a photo capture
//     never touches it), but the resolve that lands is text; a mode-derived
//     source would read "ai_photo" and never notice the second resolve.
// All three fail on the `source` field of the real createLog payload under
// a reverted `sourceForMode(mode)` — mutation-verified against a reverted
// `sourceForMode(mode)`, see the PR that introduced this block.
//
// The remaining three (voice, fresh barcode, cached-fallback barcode) can't
// be built to disagree: "Hold to record"/"Stop recording" only exists once `mode` is
// "voice", and "capture-camera-view" only exists once `mode` is "scan" — so
// `mode` and the resolve necessarily match in those tests, and they stay
// green under the old `sourceForMode(mode)` too. They still earn their
// place here: each pins its handler to stamping the correct literal via
// applyResolution — rather than nothing, a typo, or the wrong modality —
// just not specifically the tab-vs-modality confusion this file is named
// for.
describe("Add to diary — source follows the resolve, not the tab", () => {
  test("typing on the Photo tab (the default) logs ai_text, not ai_photo", async () => {
    // CaptureScreen mounts with mode="photo" and this test never switches
    // away from it — the composer is used exactly as it sits on that tab.
    const rendered = await render(<CaptureScreen />);
    const input = await rendered.findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "a bowl of oats");
    await fireEvent.press(await rendered.findByLabelText("Send"));

    const [, options] = mockResolveTextMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_text" }));
  });

  test("a photo capture via the quick-capture shortcut, from the Type tab, logs ai_photo", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });

    // Mode is switched to "type" first — the resolve is still a photo, so a
    // mode-derived source would read "ai_text" here, not "ai_photo".
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Type"));
    await fireEvent.press(await rendered.findByLabelText("Quick photo capture"));

    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, options] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_photo" }));
  });

  test("a voice resolve logs ai_voice", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Voice"));
    await fireEvent.press(await rendered.findByLabelText("Hold to record"));
    await fireEvent.press(await rendered.findByLabelText("Stop recording"));

    await waitFor(() => expect(mockResolveVoiceMutate).toHaveBeenCalled());
    const [, options] = mockResolveVoiceMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_voice" }));
  });

  test("a fresh barcode resolve logs ai_barcode", async () => {
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Scan"));
    const cameraView = await rendered.findByTestId("capture-camera-view");
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });

    await waitFor(() => expect(mockResolveBarcodeMutate).toHaveBeenCalled());
    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => options.onSuccess(makeResolution()));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_barcode" }));
  });

  // A cache hit means no AI ran, but the modality was still a barcode scan —
  // and barcode is already classified zero-COGS in #43, so it keeps ai_barcode.
  test("a cached-fallback barcode resolve still logs ai_barcode", async () => {
    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByText("Scan"));
    const cameraView = await rendered.findByTestId("capture-camera-view");
    await act(async () => {
      cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
    });

    const [, options] = mockResolveBarcodeMutate.mock.calls[0];
    await act(async () => options.onSuccess(resolutionFromCachedFood(cachedBarcodeFood)));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_barcode" }));
  });

  // Last-resolve-wins: a photo resolve followed by a typed refinement must
  // replace the source with ai_text, not keep (or blend with) ai_photo.
  test("last-resolve-wins: a photo resolve followed by a typed send logs ai_text", async () => {
    (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
    });

    const rendered = await render(<CaptureScreen />);
    await fireEvent.press(await rendered.findByLabelText("Photo viewfinder"));

    await waitFor(() => expect(mockResolvePhotoMutate).toHaveBeenCalled());
    const [, photoOptions] = mockResolvePhotoMutate.mock.calls[0];
    await act(async () => photoOptions.onSuccess(makeResolution()));

    const input = await rendered.findByLabelText("Tell Otto what you ate");
    await fireEvent.changeText(input, "actually it was toast");
    await fireEvent.press(await rendered.findByLabelText("Send"));
    const [, textOptions] = mockResolveTextMutate.mock.calls[0];
    await act(async () => textOptions.onSuccess(makeResolution()));

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalled());
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ source: "ai_text" }));
  });
});

describe("Resolving an uncertain item", () => {
  test("picking a food for an uncertain item makes it loggable without inventing a kcal", async () => {
    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered, makeMixedCertaintyResolution());

    // The uncertain row is pressable and opens the picker.
    await fireEvent.press(await rendered.findByLabelText("Confirm Rice dish"));
    await fireEvent.press(await rendered.findByText("White rice, cooked"));

    // Promoted: counted by the CTA, but still no fabricated kcal — neither a
    // "0 kcal" from the placeholder nor the stale 260 of the guess it replaced.
    expect(await rendered.findByText("Add 2 items to diary")).toBeTruthy();
    expect(rendered.queryByText("0 kcal")).toBeNull();
    expect(rendered.queryByText("260 kcal")).toBeNull();

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));

    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(2));
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ food_item_id: "picked", quantity_grams: 200 }),
    );
  });

  // A promotion belongs to the capture it was made in. If it survived into the
  // next resolve it would silently relabel a different food — the user would
  // press "Add to diary" and log something they never picked.
  test("a promotion does not survive the next resolve", async () => {
    const rendered = await render(<CaptureScreen />);
    await resolveWithMultiCandidates(rendered, makeMixedCertaintyResolution());

    await fireEvent.press(await rendered.findByLabelText("Confirm Rice dish"));
    await fireEvent.press(await rendered.findByText("White rice, cooked"));
    expect(await rendered.findByText("Add 2 items to diary")).toBeTruthy();

    // A brand-new capture, same shape — the second candidate is uncertain again.
    await resolveWithMultiCandidates(rendered, makeMixedCertaintyResolution(), 1);

    expect(await rendered.findByText("Add 1 item to diary")).toBeTruthy();
    expect(rendered.getByText("Rice dish")).toBeTruthy();
    expect(rendered.queryByText("White rice, cooked")).toBeNull();

    await fireEvent.press(await rendered.findByLabelText("Add to diary"));
    await waitFor(() => expect(mockCreateLogMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ food_item_id: "a" }),
    );
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


// The composer used to render a camera icon and a text field in EVERY mode, so
// selecting Voice left a photo button under a "Tell Otto what you ate…" field
// that did nothing for voice. These pin the composer to the selected mode.
describe("Composer follows the selected mode", () => {
  test("voice mode shows a hold-to-record control and no camera or text field", async () => {
    const { findByText, findByLabelText, queryByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));

    expect(await findByLabelText("Hold to record")).toBeTruthy();
    // The camera button is precisely what made Voice read as a photo capture.
    expect(queryByLabelText("Quick photo capture")).toBeNull();
    expect(queryByLabelText("Tell Otto what you ate")).toBeNull();
    expect(queryByLabelText("Send")).toBeNull();
  });

  test("scan mode shows a barcode control and no text field", async () => {
    const { findByText, findByLabelText, queryByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Scan"));

    expect(await findByLabelText("Scan a barcode")).toBeTruthy();
    expect(queryByLabelText("Tell Otto what you ate")).toBeNull();
    expect(queryByLabelText("Hold to record")).toBeNull();
  });

  test("photo and type modes keep the text field and the quick-capture camera", async () => {
    const { findByText, findByLabelText, queryByLabelText } = await render(<CaptureScreen />);

    expect(await findByLabelText("Quick photo capture")).toBeTruthy();
    expect(await findByLabelText("Tell Otto what you ate")).toBeTruthy();
    expect(queryByLabelText("Hold to record")).toBeNull();

    await fireEvent.press(await findByText("Type"));
    expect(await findByLabelText("Tell Otto what you ate")).toBeTruthy();
    expect(queryByLabelText("Hold to record")).toBeNull();
  });
});

describe("Voice cancel", () => {
  // The one voice transition with a direct cost consequence if it is wrong: a
  // clip the user explicitly abandoned must never reach the paid transcription
  // endpoint. The pan gesture that triggers this in real use cannot be
  // simulated (gesture-handler is mocked, so a synthesised pan would exercise
  // the mock, not the app — the vacuous-green pattern that let #82 ship). The
  // gesture's DECISIONS are tested against the pure reducer in
  // src/capture/__tests__/voiceRecording.test.ts; this covers the accessible
  // Cancel control, which reaches the same handler.
  test("cancelling stops the recorder and never calls the resolve mutation", async () => {
    const recorder = makeRecorder();
    (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

    const { findByText, findByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));
    await fireEvent.press(await findByLabelText("Hold to record"));

    // Cancel only renders while recording, so finding it proves we started.
    await fireEvent.press(await findByLabelText("Cancel recording"));

    await waitFor(() => expect(recorder.stop).toHaveBeenCalled());
    // Binding: the recorder exposes a real uri, so an implementation that
    // forwarded it would upload. Nothing may be sent.
    expect(recorder.uri).toBeTruthy();
    expect(mockResolveVoiceMutate).not.toHaveBeenCalled();
  });

  test("the idle voice affordance is a display, not a second record button", async () => {
    (useAudioRecorder as jest.Mock).mockReturnValue(makeRecorder());
    const { findByText, findByTestId, queryAllByLabelText } = await render(<CaptureScreen />);
    await fireEvent.press(await findByText("Voice"));

    expect(await findByTestId("capture-idle-voice")).toBeTruthy();
    // Exactly one control starts a recording — the composer's. The 72px mic in
    // the thread used to be a competing button with the same job.
    expect(queryAllByLabelText("Hold to record")).toHaveLength(1);
    expect(queryAllByLabelText("Start recording")).toHaveLength(0);
  });
});
