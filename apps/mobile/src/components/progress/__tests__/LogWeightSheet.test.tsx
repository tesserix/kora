import { act, fireEvent, render } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { LogWeightSheet } from "../LogWeightSheet";

// See RecipeParseSheet.test.tsx's own comment: the real "@/lib/api" pulls in
// firebase/auth (real ESM) which Jest cannot parse unmocked. Only ApiError is
// needed here — it's the type readFailureMessage narrows on to route a
// status code to its own copy.
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
}));

jest.mock("@/lib/localDate", () => ({ localDateNow: () => "2026-08-22" }));
const todayFields = { logged_at: "2026-08-22T12:00:00Z", local_date: "2026-08-22" };

// Two independent knobs, not one — see BodyCompositionScanSheet.test.tsx's
// original comment (this replaces it): isOnline() (the same-instant snapshot
// pickAndRead re-checks) and useIsOnline() (the reactive value the button's
// render gates on) are mocked separately so a test can simulate connectivity
// flipping between a stale render and the actual tap.
let mockIsOnline = true;
let mockUseIsOnline = true;
jest.mock("@/offline/connectivity", () => ({
  isOnline: () => mockIsOnline,
  useIsOnline: () => mockUseIsOnline,
}));

const mockReadMutate = jest.fn();
const mockAddMutate = jest.fn();
let mockReadPending = false;
let mockAddPending = false;
jest.mock("@/api/hooks", () => ({
  useReadBodyComposition: () => ({ mutate: mockReadMutate, isPending: mockReadPending }),
  useAddWeight: () => ({ mutate: mockAddMutate, isPending: mockAddPending }),
}));

const mockToastShow = jest.fn();
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockToastShow }) }));

const mockUseUnits = jest.fn();
jest.mock("@/units", () => ({
  ...jest.requireActual("@/units"),
  useUnits: () => mockUseUnits(),
}));

beforeEach(() => {
  mockIsOnline = true;
  mockUseIsOnline = true;
  mockReadPending = false;
  mockAddPending = false;
  mockReadMutate.mockClear();
  mockAddMutate.mockClear();
  mockToastShow.mockClear();
  mockUseUnits.mockReturnValue({ system: "metric", setSystem: jest.fn() });
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockReset();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockReset();
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});

function mockPickedPhoto() {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file://scale.jpg", fileName: "scale.jpg", mimeType: "image/jpeg" }],
  });
}

describe("Manual mode", () => {
  test("opens collapsed, on Manual, with only the weight field and Save", async () => {
    const { getByTestId, getByLabelText, queryByTestId } = await render(
      <LogWeightSheet visible onClose={jest.fn()} />,
    );
    expect(getByTestId("log-weight-mode-segment-manual").props.accessibilityState.selected).toBe(true);
    expect(getByLabelText("Weight in kilograms")).toBeTruthy();
    expect(queryByTestId("composition-date")).toBeNull();
    expect(queryByTestId("composition-derived")).toBeNull();
  });

  test("the expanding section reveals composition fields", async () => {
    const { getByTestId, getByLabelText } = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await fireEvent.press(getByTestId("composition-expand-toggle"));
    expect(getByTestId("composition-date")).toBeTruthy();
    expect(getByLabelText("Body fat percent")).toBeTruthy();
  });

  test("a weight-only save sends no composition keys, and stays two taps: open, type, Save", async () => {
    const { getByLabelText, getByText } = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));
    expect(mockAddMutate).toHaveBeenCalledTimes(1);
    const [payload] = mockAddMutate.mock.calls[0];
    expect(payload).toEqual({ weight_kg: 70.2, source: "manual", ...todayFields });
  });

  test("seeds the weight field from the last known weight, like the pre-#314 WeightLogSheet did", async () => {
    const { getByLabelText } = await render(<LogWeightSheet visible initialKg={72.4} onClose={jest.fn()} />);
    expect(getByLabelText("Weight in kilograms").props.value).toBe("72.4");
  });

  test("does not seed a weight when none is known (initialKg <= 0)", async () => {
    const { getByLabelText } = await render(<LogWeightSheet visible initialKg={0} onClose={jest.fn()} />);
    expect(getByLabelText("Weight in kilograms").props.value).toBe("");
  });

  test("closes on a successful save, and surfaces a failure instead of closing over it", async () => {
    const onClose = jest.fn();
    const { getByLabelText, getByText, findByText } = await render(
      <LogWeightSheet visible onClose={onClose} />,
    );
    await fireEvent.changeText(getByLabelText("Weight in kilograms"), "70.2");
    await fireEvent.press(getByText("Save"));
    await act(async () => mockAddMutate.mock.calls[0][1].onError());
    expect(await findByText("Couldn't save. Try again.")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.press(getByText("Save"));
    await act(async () => mockAddMutate.mock.calls[1][1].onSuccess());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Screenshot mode", () => {
  async function switchToScreenshot(utils: Awaited<ReturnType<typeof render>>) {
    await fireEvent.press(utils.getByTestId("log-weight-mode-segment-screenshot"));
  }

  test("choosing a screenshot reads it, opens the confirm form ALREADY EXPANDED and pre-filled", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({
        reading: { weight_kg: 70.2, body_fat_pct: 24.2, reading_date: "2026-08-19" },
        dropped_fields: [],
        unreadable: false,
      }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });

    // Already expanded — a screenshot arrives WITH composition values, so
    // there is something to show immediately, unlike Manual mode's bare tap.
    expect(utils.getByTestId("composition-derived")).toBeTruthy();
    expect(utils.getByLabelText("Weight in kilograms").props.value).toBe("70.2");
    expect(utils.getByLabelText("Body fat percent").props.value).toBe("24.2");
    // Never a defaulted zero for what the reader never saw.
    expect(utils.getByLabelText("Protein percent").props.value).toBe("");
    expect(utils.getByLabelText("Reading date").props.value).toBe("2026-08-19");
  });

  test("a fully absent instrument (API hasn't shipped it yet) falls back to scale_screenshot, pre-selected", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({ reading: { weight_kg: 70.2 }, dropped_fields: [], unreadable: false }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    // Rendered as the existing multi-entry control (correctable), not a
    // stated fact — but pre-selected to the fallback.
    expect(utils.getByTestId("composition-source")).toBeTruthy();
    await fireEvent.press(utils.getByText("Save"));
    expect(mockAddMutate.mock.calls[0][0].source).toBe("scale_screenshot");
  });

  test("a recognised instrument (once the API sends one) pre-selects that instrument, correctably", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({
        // Not on BodyCompositionReading's declared type on this branch —
        // exactly what the sibling instrument-detection PR will add. Cast
        // through `as never` at the call site is unnecessary here because
        // this is the raw mutation-mocked object, not a typed import.
        reading: { weight_kg: 70.2, instrument: "dexa" },
        dropped_fields: [],
        unreadable: false,
      }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    await fireEvent.press(utils.getByText("Save"));
    expect(mockAddMutate.mock.calls[0][0].source).toBe("dexa");
  });

  test("the detected instrument is correctable — pressing a different segment changes what saves", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({ reading: { weight_kg: 70.2, instrument: "dexa" }, dropped_fields: [], unreadable: false }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    await fireEvent.press(utils.getByTestId("composition-source-segment-inbody"));
    await fireEvent.press(utils.getByText("Save"));
    expect(mockAddMutate.mock.calls[0][0].source).toBe("inbody");
  });

  test("an unrecognised instrument falls back to scale_screenshot rather than erroring", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({
        reading: { weight_kg: 70.2, instrument: "some_future_instrument" },
        dropped_fields: [],
        unreadable: false,
      }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    await fireEvent.press(utils.getByText("Save"));
    expect(mockAddMutate.mock.calls[0][0].source).toBe("scale_screenshot");
  });

  test("surfaces which fields were dropped and why, on an otherwise successful read", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({
        reading: { weight_kg: 70.2 },
        dropped_fields: [{ field: "bone_mass_kg", reason: "bone_mass_kg -3.1 is not positive" }],
        unreadable: false,
      }),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(
      await utils.findByText(
        "Your scale's bone mass didn't look right on that screenshot, so it was left out — check it below.",
      ),
    ).toBeTruthy();
  });

  test("a 422 unreadable read opens the confirm form EMPTY, with an explanation, and still on Save", async () => {
    mockPickedPhoto();
    const { ApiError } = jest.requireMock("@/lib/api");
    mockReadMutate.mockImplementation((_file, { onError }) =>
      onError(new ApiError(422, "unreadable", "couldn't read anything from that screenshot")),
    );
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(await utils.findByText(/couldn't read anything from that screenshot/i)).toBeTruthy();
    expect(utils.getByLabelText("Weight in kilograms").props.value).toBe("");
    expect(utils.getByLabelText("Reading date").props.value).toBe("2026-08-22");
  });

  test("a 429 shows the AI-limit message and offers no retry, only manual entry", async () => {
    mockPickedPhoto();
    const { ApiError } = jest.requireMock("@/lib/api");
    mockReadMutate.mockImplementation((_file, { onError }) => onError(new ApiError(429, "budget_exhausted", "limit reached")));
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(await utils.findByText(/AI usage limit/i)).toBeTruthy();
    expect(utils.queryByText(/try again/i)).toBeNull();
    expect(utils.queryByText(/retry/i)).toBeNull();
    expect(await utils.findByText("Save")).toBeTruthy();
  });

  test("a 503 says the reader is unavailable and offers manual entry", async () => {
    mockPickedPhoto();
    const { ApiError } = jest.requireMock("@/lib/api");
    mockReadMutate.mockImplementation((_file, { onError }) => onError(new ApiError(503, "unavailable", "no provider configured")));
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(await utils.findByText(/isn't available right now/i)).toBeTruthy();
    expect(await utils.findByText("Save")).toBeTruthy();
  });

  test("a network failure (no ApiError at all) also falls back to manual entry", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onError }) => onError(new Error("fetch failed")));
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(await utils.findByText(/couldn't reach kora/i)).toBeTruthy();
    expect(await utils.findByText("Save")).toBeTruthy();
  });

  // The whole point of kora#314's no-storage decision: this path never
  // queues. Offline, it must say so up front rather than attempt (and
  // silently fail) a picker/upload.
  test("offline, it explains why up front instead of attempting to read anything", async () => {
    mockIsOnline = false;
    mockUseIsOnline = false;
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    expect(await utils.findByText(/you're offline/i)).toBeTruthy();
    expect(utils.queryByText("Choose screenshot")).toBeNull();
    expect(mockReadMutate).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(await utils.findByText("Enter manually"));
    });
    expect(utils.getByTestId("composition-derived")).toBeTruthy(); // fallback opens expanded too
    expect(mockReadMutate).not.toHaveBeenCalled();
  });

  // The gap useIsOnline()'s reactive gate above cannot close on its own: it
  // renders "Choose screenshot" from whatever connectivity looked like at the
  // last render, and a device can go offline in the moment between that
  // render and the tap landing. pickAndRead's own same-instant isOnline()
  // re-check exists for exactly this gap — this proves it still fires after
  // moving into LogWeightSheet.
  test("a connection lost between render and tap still gets caught before any upload", async () => {
    mockUseIsOnline = true; // button renders as available…
    mockIsOnline = false; // …but the snapshot at tap time says otherwise
    const utils = await render(<LogWeightSheet visible onClose={jest.fn()} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    expect(await utils.findByText(/you're offline/i)).toBeTruthy();
    expect(mockReadMutate).not.toHaveBeenCalled();
  });

  test("saving the confirmed reading posts through useAddWeight and closes on success", async () => {
    mockPickedPhoto();
    mockReadMutate.mockImplementation((_file, { onSuccess }) =>
      onSuccess({ reading: { weight_kg: 70.2 }, dropped_fields: [], unreadable: false }),
    );
    const onClose = jest.fn();
    const utils = await render(<LogWeightSheet visible onClose={onClose} />);
    await switchToScreenshot(utils);
    await act(async () => {
      fireEvent.press(await utils.findByText("Choose screenshot"));
    });
    await fireEvent.press(utils.getByText("Save"));

    expect(mockAddMutate).toHaveBeenCalledTimes(1);
    const [payload, handlers] = mockAddMutate.mock.calls[0];
    expect(payload.source).toBe("scale_screenshot");
    expect(payload.weight_kg).toBe(70.2);
    await act(async () => handlers.onSuccess());
    expect(onClose).toHaveBeenCalled();
  });
});

test("reopening the sheet resets back to Manual mode, collapsed", async () => {
  mockPickedPhoto();
  mockReadMutate.mockImplementation((_file, { onSuccess }) =>
    onSuccess({ reading: { weight_kg: 70.2 }, dropped_fields: [], unreadable: false }),
  );
  const { getByTestId, findByText, rerender } = await render(<LogWeightSheet visible onClose={jest.fn()} />);
  await fireEvent.press(getByTestId("log-weight-mode-segment-screenshot"));
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(getByTestId("composition-derived")).toBeTruthy();

  await rerender(<LogWeightSheet visible={false} onClose={jest.fn()} />);
  await rerender(<LogWeightSheet visible onClose={jest.fn()} />);
  expect(getByTestId("log-weight-mode-segment-manual").props.accessibilityState.selected).toBe(true);
  expect(await findByText("Save")).toBeTruthy();
});
