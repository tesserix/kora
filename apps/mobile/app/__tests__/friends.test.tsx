import { render, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";

import Friends from "../friends";

const mockAcceptMutate = jest.fn();
const mockDeclineMutate = jest.fn();
const mockUnfriendMutate = jest.fn();
const mockShow = jest.fn();

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
jest.mock("@/api/hooks", () => ({
  useFriends: () => ({ data: [{ id: "u1", display_name: "Ada" }] }),
  useFriendRequests: () => ({ data: { incoming: [{ id: "r1", user: { id: "u2", display_name: "Ben" } }], outgoing: [] } }),
  useAcceptRequest: () => ({ mutate: mockAcceptMutate, isPending: false }),
  useDeclineRequest: () => ({ mutate: mockDeclineMutate, isPending: false }),
  useUnfriend: () => ({ mutate: mockUnfriendMutate, isPending: false }),
  useSendFriendRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
  useFriendsProgress: () => ({ data: { me: { streak_days: 2, adherence_days: 1, adherence_window: 7 }, friends: [] } }),
}));

beforeEach(() => {
  mockAcceptMutate.mockClear();
  mockDeclineMutate.mockClear();
  mockUnfriendMutate.mockClear();
  mockShow.mockClear();
});

// #83: every mutation on this screen now carries an onError that surfaces the
// failure. Asserted as a second argument rather than ignored, so a future edit
// that drops the handler fails here instead of silently going quiet again.
const withOnError = expect.objectContaining({ onError: expect.any(Function) });

const OFFLINE = Object.assign(new Error("down"), { name: "NetworkError" });
const OFFLINE_COPY = "Couldn't reach Kora. Check your connection.";

test("renders friends and incoming requests; Accept calls the hook with the request id", async () => {
  const { getByText, getByLabelText } = await render(<Friends />);
  expect(getByText("Ada")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
  await fireEvent.press(getByLabelText("Accept request from Ben"));
  expect(mockAcceptMutate).toHaveBeenCalledWith("r1", withOnError);
});

test("a failed Accept tells the user why", async () => {
  const { getByLabelText } = await render(<Friends />);
  await fireEvent.press(getByLabelText("Accept request from Ben"));
  mockAcceptMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

test("a failed Decline tells the user why", async () => {
  const { getByLabelText } = await render(<Friends />);
  await fireEvent.press(getByLabelText("Decline request from Ben"));
  mockDeclineMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

// Unfriend is behind a native confirm Alert, which cannot be pressed for real
// here — but its destructive handler is the whole unfriend path. Same approach
// as diary-delete.test.tsx.
test("a failed Remove-friend tells the user why", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByLabelText } = await render(<Friends />);
  // Bound to onLongPress, not onPress — a `press` here fires nothing and the
  // Alert spy stays empty.
  await fireEvent(getByLabelText("Remove Ada"), "longPress");

  const buttons = alert.mock.calls.at(-1)?.[2] as { style?: string; onPress?: () => void }[];
  buttons.find((b) => b.style === "destructive")!.onPress!();

  expect(mockUnfriendMutate).toHaveBeenCalledWith("u1", withOnError);
  mockUnfriendMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
  alert.mockRestore();
});
