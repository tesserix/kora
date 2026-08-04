import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { useCameraPermissions } from "expo-camera";
import { requestRecordingPermissionsAsync, useAudioRecorder } from "expo-audio";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({ router: { back: jest.fn(), push: jest.fn() } }));

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

const mockResolveTextMutate = jest.fn();
const mockResolvePhotoMutate = jest.fn();
const mockResolveVoiceMutate = jest.fn();
const mockResolveBarcodeMutate = jest.fn();
const mockCreateLogMutateAsync = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => ({ data: { display_name: "Alex Stone" } }),
  useResolveText: () => ({ mutate: mockResolveTextMutate, isPending: false }),
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

import CaptureScreen from "../capture";

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
  mockResolveTextMutate.mockReset();
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

test("a typed resolve logs the phrase the user actually typed", async () => {
  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Type"));

  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "brekkie eggs");
  await fireEvent.press(await findByLabelText("Send"));

  const [, options] = mockResolveTextMutate.mock.calls[0];
  await act(async () => options.onSuccess(makeResolution()));

  await fireEvent.press(await findByLabelText("Add to diary"));

  expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ input_phrase: "brekkie eggs", source: "ai_text" }),
  );
});

test("a voice resolve logs the server's transcript", async () => {
  const recorder = makeRecorder();
  (useAudioRecorder as jest.Mock).mockReturnValue(recorder);

  const { findByText, findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByText("Voice"));
  await fireEvent.press(await findByLabelText("Hold to record"));
  await fireEvent.press(await findByLabelText("Stop recording"));

  const [, options] = mockResolveVoiceMutate.mock.calls[0];
  await act(async () => options.onSuccess(makeResolution({ transcript: "two boiled eggs" })));

  await fireEvent.press(await findByLabelText("Add to diary"));

  expect(mockCreateLogMutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({ input_phrase: "two boiled eggs", source: "ai_voice" }),
  );
});

test("a photo resolve sends no input_phrase", async () => {
  (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
  });

  const { findByLabelText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByLabelText("Photo viewfinder"));

  const [, options] = mockResolvePhotoMutate.mock.calls[0];
  await act(async () => options.onSuccess(makeResolution()));

  await fireEvent.press(await findByLabelText("Add to diary"));

  expect(mockCreateLogMutateAsync).toHaveBeenCalled();
  const [payload] = mockCreateLogMutateAsync.mock.calls[0];
  expect(payload).not.toHaveProperty("input_phrase");
});

// Regression guard: the tests above each render a fresh CaptureScreen, so
// `resolvedPhrase` starts at its useState default of null regardless of
// whether the photo/barcode handlers ever call setResolvedPhrase(null). That
// makes them blind to the actual risk — a phrase left over from an earlier
// TEXT (or VOICE) resolve leaking into a LATER photo/barcode-sourced log.
// These chain a real text resolve first, in the same mounted component, so
// resolvedPhrase is genuinely non-null before the photo/barcode resolve runs.
//
// Both cases below are now double-guarded, but they got there differently —
// neither case's *assertion* (no input_phrase leak) was ever wrong, but only
// the photo case's *bindingness* ever depended on the tab-vs-modality bug
// fixed in capture.tsx. The photo case captures via the quick-capture
// shortcut while `mode` is still "type": under the old (now-deleted)
// `sourceForMode(mode)`, that was the one way to make `source` read
// "ai_text" for a photo resolve, so the input_phrase gate below actually
// depended on setResolvedPhrase(null) rather than excluding input_phrase for
// a reason unrelated to resolvedPhrase. The barcode case never had that
// bindingness to begin with: reaching the camera view at all requires
// switching to "Scan" mode, so `source` was "ai_barcode" — and the gate
// excluded input_phrase — under the old mode-derived code too. Today,
// `source` is stamped by applyResolution from the resolve that actually ran,
// never from `mode` (see capture.tsx), so both cases are excluded by the
// `source === "ai_text" || "ai_voice"` gate on their own. The
// setResolvedPhrase(null) call in each handler's onSuccess is therefore
// defense-in-depth, not the sole guard — it only matters if the gate is ever
// keyed off something other than `source`.
test("a phrase from an earlier text resolve does not leak into a later photo resolve", async () => {
  const { findByText, findByLabelText } = await render(<CaptureScreen />);

  // 1. Resolve text with a phrase — populates resolvedPhrase, not logged.
  // Stays on the default Photo tab: the composer's field and Send are
  // available there too, and the property under test keys off `source`, not
  // `mode`. (It used to switch to Type and capture via the quick-capture
  // shortcut, a route removed when the Type button became a keyboard.)
  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "brekkie eggs");
  await fireEvent.press(await findByLabelText("Send"));

  const [, textOptions] = mockResolveTextMutate.mock.calls[0];
  await act(async () => textOptions.onSuccess(makeResolution()));

  // 2. Resolve a photo via the quick-capture shortcut, same session.
  (ImagePicker.launchCameraAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file://x.jpg", fileName: "x.jpg", mimeType: "image/jpeg" }],
  });
  await fireEvent.press(await findByLabelText("Quick photo capture"));

  const [, photoOptions] = mockResolvePhotoMutate.mock.calls[0];
  await act(async () => photoOptions.onSuccess(makeResolution()));

  // 3. Add to diary.
  await fireEvent.press(await findByLabelText("Add to diary"));

  // 4. The created log must carry no input_phrase — a photo has no words
  // the user uttered, and the stale "brekkie eggs" phrase must not leak in.
  expect(mockCreateLogMutateAsync).toHaveBeenCalled();
  const [payload] = mockCreateLogMutateAsync.mock.calls[0];
  expect(payload).not.toHaveProperty("input_phrase");
});

test("a phrase from an earlier text resolve does not leak into a later barcode resolve", async () => {
  const { findByText, findByLabelText, findByTestId } = await render(<CaptureScreen />);

  // 1. Resolve text with a phrase — populates resolvedPhrase, not logged.
  // Stays on the default Photo tab: the composer's field and Send are
  // available there too, and the property under test keys off `source`, not
  // `mode`. (It used to switch to Type and capture via the quick-capture
  // shortcut, a route removed when the Type button became a keyboard.)
  const input = await findByLabelText("Tell Otto what you ate");
  await fireEvent.changeText(input, "brekkie eggs");
  await fireEvent.press(await findByLabelText("Send"));

  const [, textOptions] = mockResolveTextMutate.mock.calls[0];
  await act(async () => textOptions.onSuccess(makeResolution()));

  // 2. Switch to Scan mode and resolve a barcode in the same mounted component.
  await fireEvent.press(await findByText("Scan"));
  const cameraView = await findByTestId("capture-camera-view");
  await act(async () => {
    cameraView.props.onBarcodeScanned({ data: "012345678905", type: "ean13" });
  });

  await waitFor(() => expect(mockResolveBarcodeMutate).toHaveBeenCalled());
  const [, barcodeOptions] = mockResolveBarcodeMutate.mock.calls[0];
  await act(async () => barcodeOptions.onSuccess(makeResolution()));

  // 3. Add to diary.
  await fireEvent.press(await findByLabelText("Add to diary"));

  // 4. The created log must carry no input_phrase — a barcode has no words
  // the user uttered, and the stale "brekkie eggs" phrase must not leak in.
  expect(mockCreateLogMutateAsync).toHaveBeenCalled();
  const [payload] = mockCreateLogMutateAsync.mock.calls[0];
  expect(payload).not.toHaveProperty("input_phrase");
});
