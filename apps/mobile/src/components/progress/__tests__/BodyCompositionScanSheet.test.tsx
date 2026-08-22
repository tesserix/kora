import { act, fireEvent, render } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";
import { BodyCompositionScanSheet } from "../BodyCompositionScanSheet";

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

// Two independent knobs, not one — isOnline() (the same-instant snapshot
// pickAndRead re-checks) and useIsOnline() (the reactive value the button's
// render gates on) are mocked SEPARATELY so a test can simulate connectivity
// flipping between a stale render and the actual tap, exactly like
// isOnline()'s own doc comment in src/api/hooks.ts describes for every other
// write path in the app.
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

beforeEach(() => {
  mockIsOnline = true;
  mockUseIsOnline = true;
  mockReadPending = false;
  mockAddPending = false;
  mockReadMutate.mockClear();
  mockAddMutate.mockClear();
  mockToastShow.mockClear();
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

test("choosing a screenshot reads it and pre-fills the confirm form, omitting fields the reader could not see", async () => {
  mockPickedPhoto();
  mockReadMutate.mockImplementation((_file, { onSuccess }) =>
    onSuccess({
      reading: { weight_kg: 70.2, body_fat_pct: 24.2, reading_date: "2026-08-19" },
      dropped_fields: [],
      unreadable: false,
    }),
  );
  const { findByText, getByLabelText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });

  expect(await findByText("Confirm reading")).toBeTruthy();
  expect(getByLabelText("Weight in kilograms").props.value).toBe("70.2");
  expect(getByLabelText("Body fat percent").props.value).toBe("24.2");
  // Never a defaulted zero for what the reader never saw.
  expect(getByLabelText("Protein percent").props.value).toBe("");
  // The screenshot's own date, not today's.
  expect(getByLabelText("Reading date").props.value).toBe("2026-08-19");
  expect(await findByText("Scale screenshot")).toBeTruthy();
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
  const { findByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(
    await findByText("Your scale's bone mass didn't look right on that screenshot, so it was left out — check it below."),
  ).toBeTruthy();
});

test("a 422 unreadable read opens the confirm form EMPTY, with an explanation", async () => {
  mockPickedPhoto();
  const { ApiError } = jest.requireMock("@/lib/api");
  mockReadMutate.mockImplementation((_file, { onError }) =>
    onError(new ApiError(422, "unreadable", "couldn't read anything from that screenshot")),
  );
  const { findByText, getByLabelText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(await findByText(/couldn't read anything from that screenshot/i)).toBeTruthy();
  expect(getByLabelText("Weight in kilograms").props.value).toBe("");
  // Falls back to today, same as a manual entry with no reading date at all.
  expect(getByLabelText("Reading date").props.value).toBe("2026-08-22");
});

test("a 429 shows the AI-limit message and offers no retry, only manual entry", async () => {
  mockPickedPhoto();
  const { ApiError } = jest.requireMock("@/lib/api");
  mockReadMutate.mockImplementation((_file, { onError }) =>
    onError(new ApiError(429, "budget_exhausted", "limit reached")),
  );
  const { findByText, queryByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(await findByText(/AI usage limit/i)).toBeTruthy();
  // No "Try again"/"Retry" affordance for a quota that won't clear itself.
  expect(queryByText(/try again/i)).toBeNull();
  expect(queryByText(/retry/i)).toBeNull();
  expect(await findByText("Save")).toBeTruthy();
});

test("a 503 says the reader is unavailable and offers manual entry", async () => {
  mockPickedPhoto();
  const { ApiError } = jest.requireMock("@/lib/api");
  mockReadMutate.mockImplementation((_file, { onError }) =>
    onError(new ApiError(503, "unavailable", "no provider configured")),
  );
  const { findByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(await findByText(/isn't available right now/i)).toBeTruthy();
  expect(await findByText("Save")).toBeTruthy();
});

test("a network failure (no ApiError at all) also falls back to manual entry", async () => {
  mockPickedPhoto();
  mockReadMutate.mockImplementation((_file, { onError }) => onError(new Error("fetch failed")));
  const { findByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(await findByText(/couldn't reach kora/i)).toBeTruthy();
  expect(await findByText("Save")).toBeTruthy();
});

// The whole point of kora#314's no-storage decision: this path never queues.
// Offline, it must say so up front rather than attempt (and silently fail)
// a picker/upload — see BodyCompositionScanSheet's own comment on why.
test("offline, it explains why up front instead of attempting to read anything", async () => {
  mockIsOnline = false;
  mockUseIsOnline = false;
  const { findByText, queryByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  expect(await findByText(/you're offline/i)).toBeTruthy();
  expect(queryByText("Choose screenshot")).toBeNull();
  expect(mockReadMutate).not.toHaveBeenCalled();

  fireEvent.press(await findByText("Enter manually"));
  expect(await findByText("Confirm reading")).toBeTruthy();
  expect(mockReadMutate).not.toHaveBeenCalled();
});

// The gap useIsOnline()'s reactive gate above cannot close on its own: it
// renders "Choose screenshot" from whatever connectivity looked like at the
// last render, and a device can go offline in the moment between that render
// and the tap landing. pickAndRead's own same-instant isOnline() re-check
// (see its comment) exists for exactly this gap — this proves it actually
// fires rather than being dead code the button already made unreachable.
test("a connection lost between render and tap still gets caught before any upload", async () => {
  mockUseIsOnline = true; // button renders as available…
  mockIsOnline = false; // …but the snapshot at tap time says otherwise
  const { findByText } = await render(<BodyCompositionScanSheet visible onClose={jest.fn()} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  expect(await findByText(/you're offline/i)).toBeTruthy();
  expect(mockReadMutate).not.toHaveBeenCalled();
});

test("saving the confirmed reading posts through useAddWeight and closes on success", async () => {
  mockPickedPhoto();
  mockReadMutate.mockImplementation((_file, { onSuccess }) =>
    onSuccess({ reading: { weight_kg: 70.2 }, dropped_fields: [], unreadable: false }),
  );
  const onClose = jest.fn();
  const { findByText, getByText } = await render(<BodyCompositionScanSheet visible onClose={onClose} />);
  await act(async () => {
    fireEvent.press(await findByText("Choose screenshot"));
  });
  await fireEvent.press(getByText("Save"));

  expect(mockAddMutate).toHaveBeenCalledTimes(1);
  const [payload, handlers] = mockAddMutate.mock.calls[0];
  expect(payload.source).toBe("scale_screenshot");
  expect(payload.weight_kg).toBe(70.2);
  await act(async () => handlers.onSuccess());
  expect(onClose).toHaveBeenCalled();
});
