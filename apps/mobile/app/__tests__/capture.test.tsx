import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { ApiError } from "@/lib/api";
import type { Resolution } from "@/api/types";

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));

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
let mockResolveTextIsPending = false;
let mockResolvePhotoIsPending = false;

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
}));

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

const noopBodyProps = {
  displayName: "Alex",
  insetTop: 0,
  mode: "photo" as const,
  onModeChange: jest.fn(),
  errorMsg: null,
  mealSlot: "lunch" as const,
  onChangeMealSlot: jest.fn(),
  onAdd: jest.fn(),
  adding: false,
  text: "",
  onChangeText: jest.fn(),
  onSend: jest.fn(),
  onCapturePhoto: jest.fn(),
  onClose: jest.fn(),
};

beforeEach(() => {
  mockResolveTextMutate.mockReset();
  mockResolvePhotoMutate.mockReset();
  mockResolveTextIsPending = false;
  mockResolvePhotoIsPending = false;
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset().mockResolvedValue({ granted: true });
  (ImagePicker.launchCameraAsync as jest.Mock).mockReset();
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReset();
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

test("switching mode clears a stale error bubble", async () => {
  (ImagePicker.requestCameraPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });

  const { findByLabelText, findByText, queryByText } = await render(<CaptureScreen />);
  await fireEvent.press(await findByLabelText("Photo viewfinder"));
  expect(await findByText("I need camera or photo access to see your meal.")).toBeTruthy();

  await fireEvent.press(await findByText("Type"));
  expect(queryByText("I need camera or photo access to see your meal.")).toBeNull();
});
