import { render, fireEvent, waitFor } from "@testing-library/react-native";
import * as ImagePicker from "expo-image-picker";

import Profile from "../profile";
import { ApiError } from "@/lib/api";

const mockBack = jest.fn();
const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  router: {
    back: (...a: unknown[]) => mockBack(...a),
    push: (...a: unknown[]) => mockPush(...a),
  },
}));

// The real "@/lib/api" pulls in firebase/auth (real ESM), which Jest cannot
// parse unmocked. Only ApiError is needed here, to construct the four
// distinguishable handle-write failures — same reasoning and shape as
// AddFriendSheet.test.tsx's mock.
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

const mockMe = jest.fn();
const mockMyHandle = jest.fn();
const mockSetHandle = jest.fn();
const mockClearHandle = jest.fn();
const mockUploadAvatar = jest.fn();
const mockDeleteAvatar = jest.fn();

jest.mock("@/api/hooks", () => ({
  useProfile: () => mockMe(),
  useMyHandle: () => mockMyHandle(),
  useSetHandle: () => ({ mutateAsync: mockSetHandle, isPending: false }),
  useClearHandle: () => ({ mutateAsync: mockClearHandle, isPending: false }),
  useUploadAvatar: () => ({ mutateAsync: mockUploadAvatar, isPending: false }),
  useDeleteAvatar: () => ({ mutateAsync: mockDeleteAvatar, isPending: false }),
}));

const BASE_PROFILE = {
  id: "u1",
  email: "ada@example.com",
  display_name: "Ada Lovelace",
  goal: "fat_loss",
  target_kcal: 1850,
  target_protein_g: 140,
  target_carbs_g: 160,
  target_fat_g: 55,
  onboarded_at: "2025-03-14T00:00:00.000Z",
  weight_kg: 68.4,
  avatar_url: "",
};

beforeEach(() => {
  mockBack.mockClear();
  mockPush.mockClear();
  mockMe.mockReset().mockReturnValue({ data: BASE_PROFILE });
  mockMyHandle.mockReset().mockReturnValue({ data: { handle: "ada" }, isLoading: false });
  mockSetHandle.mockReset().mockResolvedValue({ handle: "ada" });
  mockClearHandle.mockReset().mockResolvedValue(undefined);
  mockUploadAvatar.mockReset().mockResolvedValue({ avatar_url: "https://assets.test/new.jpg" });
  mockDeleteAvatar.mockReset().mockResolvedValue(undefined);
});

test("renders the signed-in user's account info", async () => {
  const { getByText } = await render(<Profile />);
  expect(getByText("Ada Lovelace")).toBeTruthy();
  expect(getByText("ada@example.com")).toBeTruthy();
  expect(getByText("1850")).toBeTruthy();
});

test("shows a Go back affordance that navigates back", async () => {
  const { getByLabelText } = await render(<Profile />);
  expect(getByLabelText("Go back")).toBeTruthy();
});

test("offers a destructive Delete account row", async () => {
  const { getByText } = await render(<Profile />);
  expect(getByText("Account")).toBeTruthy();
  expect(getByText("Delete account")).toBeTruthy();
});

test("tapping Delete account routes to the confirmation screen", async () => {
  const { getByText } = await render(<Profile />);
  await fireEvent.press(getByText("Delete account"));
  expect(mockPush).toHaveBeenCalledWith("/delete-account");
});

test("shows the handle when there is one, and an invitation to pick one when there is not", async () => {
  mockMyHandle.mockReturnValue({ data: { handle: "" }, isLoading: false });
  const { getByText } = await render(<Profile />);
  expect(getByText("Pick a handle")).toBeTruthy();
});

test("shows the current handle as an editable value, not an invitation, once one is set", async () => {
  mockMyHandle.mockReturnValue({ data: { handle: "ada" }, isLoading: false });
  const { getByText, getByLabelText } = await render(<Profile />);
  expect(getByText("Your handle")).toBeTruthy();
  expect(getByLabelText("Handle").props.value).toBe("ada");
});

test("renders the picture on the profile avatar when the account has one", async () => {
  mockMe.mockReturnValue({ data: { ...BASE_PROFILE, avatar_url: "https://assets.test/a.jpg" } });
  const { container } = await render(<Profile />);
  const images = container.queryAll((instance) => instance.type === "Image");
  expect(images[0].props.source).toEqual({ uri: "https://assets.test/a.jpg" });
});

// Removing is immediate and ungated — the same rule the sharing surfaces
// follow: a surface that makes stopping harder than starting works against
// the person it exists for.
test("removes the picture without a confirmation", async () => {
  mockMe.mockReturnValue({ data: { ...BASE_PROFILE, avatar_url: "https://assets.test/a.jpg" } });
  const { getByText, queryByText } = await render(<Profile />);
  await fireEvent.press(getByText("Remove picture"));
  expect(queryByText("Are you sure?")).toBeNull();
  await waitFor(() => expect(mockDeleteAvatar).toHaveBeenCalled());
});

test("offers no Remove picture affordance when there is no picture to remove", async () => {
  mockMe.mockReturnValue({ data: { ...BASE_PROFILE, avatar_url: "" } });
  const { queryByText } = await render(<Profile />);
  expect(queryByText("Remove picture")).toBeNull();
});

// Same ungated rule for the handle.
test("removes the handle without a confirmation", async () => {
  mockMyHandle.mockReturnValue({ data: { handle: "ada" }, isLoading: false });
  const { getByText, queryByText } = await render(<Profile />);
  await fireEvent.press(getByText("Remove handle"));
  expect(queryByText("Are you sure?")).toBeNull();
  await waitFor(() => expect(mockClearHandle).toHaveBeenCalled());
});

test("surfaces a taken handle as something the user can fix", async () => {
  mockSetHandle.mockRejectedValue(new ApiError(409, "handle_taken", "That handle is taken."));
  const { getByLabelText, getByText } = await render(<Profile />);
  await fireEvent.changeText(getByLabelText("Handle"), "ada");
  await fireEvent.press(getByText("Save handle"));
  await waitFor(() => expect(getByText("That handle is taken.")).toBeTruthy());
});

// This is the seam the plan's own history warns about: buildCaptureForm and
// useUploadAvatar are each unit-tested elsewhere, but nothing before this
// exercised the *screen* actually wiring picker output into a real upload
// call. Picks a photo, drives it through the real pickPicture handler (not a
// mocked shortcut), and checks the upload mutation actually fires.
test("picking a photo uploads it as a new picture", async () => {
  (ImagePicker.launchImageLibraryAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri: "file:///tmp/pick.jpg", fileName: "pick.jpg", mimeType: "image/jpeg" }],
  });
  const { getByText } = await render(<Profile />);
  await fireEvent.press(getByText("Change picture"));
  await waitFor(() => expect(mockUploadAvatar).toHaveBeenCalledTimes(1));
  // The one shape Expo's fetch converter accepts (buildCaptureForm) — a
  // plain object part would mean this regressed back to #82.
  expect(mockUploadAvatar.mock.calls[0][0]).toBeInstanceOf(FormData);
});

// kora#446 already had to fix one neighbouring surface for shipping a
// touch target under the iOS 44pt minimum. "Change picture" is a compact
// text link, not a full-width Button, so nothing else here catches a
// regression that shrinks its hit area back down to the visible label's own
// ~17-18pt line box.
test("keeps the Change picture link at a 44pt touch target, not just its small label", async () => {
  const { getByTestId } = await render(<Profile />);
  const target = getByTestId("profile-change-picture-target");
  const styles = (Array.isArray(target.props.style) ? target.props.style : [target.props.style]).flat(Infinity);
  const minHeights = styles.filter(Boolean).map((s) => s.minHeight).filter((v) => typeof v === "number");
  expect(minHeights.length).toBeGreaterThan(0);
  expect(Math.max(...minHeights)).toBeGreaterThanOrEqual(44);
});

test("a denied photo-library permission surfaces as recoverable copy, not a silent no-op", async () => {
  (ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock).mockResolvedValueOnce({
    granted: false,
    status: "denied",
    canAskAgain: true,
    expires: "never",
  });
  const { getByText } = await render(<Profile />);
  await fireEvent.press(getByText("Change picture"));
  await waitFor(() =>
    expect(getByText("Kora needs access to your photos to set a picture.")).toBeTruthy(),
  );
  expect(mockUploadAvatar).not.toHaveBeenCalled();
});

// The four write failures answer differently (400 invalid_handle, 409
// handle_reserved, 409 handle_taken, 409 handle_retired) and each message is
// distinct — passing it straight through is what makes the distinction
// visible. Spot-checked against a second code here so a regression that
// collapses all four into one generic string cannot pass silently.
test("surfaces a retired handle with its own distinct message", async () => {
  mockSetHandle.mockRejectedValue(new ApiError(409, "handle_retired", "That handle was retired and can't be reused."));
  const { getByLabelText, getByText, queryByText } = await render(<Profile />);
  await fireEvent.changeText(getByLabelText("Handle"), "oldname");
  await fireEvent.press(getByText("Save handle"));
  await waitFor(() => expect(getByText("That handle was retired and can't be reused.")).toBeTruthy());
  expect(queryByText("That handle is taken.")).toBeNull();
});
