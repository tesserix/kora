import { render, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";

import GroupDetail from "../group/[id]";

const mockLeaveMutate = jest.fn();
const mockRemoveMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockShow = jest.fn();
// Delete (owner) and Leave (non-owner) are mutually exclusive branches, so the
// role has to be settable to reach both.
let mockRole = "owner";

jest.mock("expo-router", () => ({ router: { back: jest.fn() }, useLocalSearchParams: () => ({ id: "g1" }) }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
jest.mock("@/api/hooks", () => ({
  useGroup: () => ({ data: { id: "g1", name: "Squad", invite_code: "CODE1234", my_role: mockRole, members: [
    { id: "u1", display_name: "Owner", role: "owner" },
    { id: "u2", display_name: "Mate", role: "member" },
  ] } }),
  useGroupProgress: () => ({ data: { members: [
    { id: "u1", display_name: "Owner", sharing: true, streak_days: 5, adherence_days: 4 },
    { id: "u2", display_name: "Mate", sharing: false },
  ] } }),
  useGroupCode: () => ({ data: { code: "CODE1234", link: "mobile://group/CODE1234" } }),
  useLeaveGroup: () => ({ mutate: mockLeaveMutate, isPending: false }),
  useRemoveMember: () => ({ mutate: mockRemoveMutate, isPending: false }),
  useDeleteGroup: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useProfile: () => ({ data: { id: "u1" } }),
  useGroupChallenges: () => ({ data: [{ id: "c1", title: "July streak", metric: "logged", status: "active", start_date: "", end_date: "", participant_count: 2, joined: true }] }),
}));

test("renders name, roster, leaderboard, and owner-only Delete", async () => {
  const { getByText, getAllByText } = await render(<GroupDetail />);
  expect(getByText("Squad")).toBeTruthy();
  // "Owner" (the sharing member's display_name) renders once in the leaderboard
  // row and once in the roster row below it.
  expect(getAllByText("Owner")).toHaveLength(2);
  expect(getByText("Mate")).toBeTruthy();
  expect(getByText("4/7 on target")).toBeTruthy(); // leaderboard, sharing member
  expect(getByText("Delete group")).toBeTruthy(); // my_role owner
  expect(getByText("July streak")).toBeTruthy(); // challenges section
});

// #83: these three are the sharpest sites in the issue — their buttons gate on
// isPending, so a silent failure reads as a broken control rather than a failed
// request. (The gate does re-enable; see mutation-error-surface.test.tsx.)
const OFFLINE = Object.assign(new Error("down"), { name: "NetworkError" });
const OFFLINE_COPY = "Couldn't reach Kora. Check your connection.";

beforeEach(() => {
  mockLeaveMutate.mockClear();
  mockRemoveMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockShow.mockClear();
  mockRole = "owner";
});

function pressDestructive(alert: jest.SpyInstance) {
  const buttons = alert.mock.calls.at(-1)?.[2] as { style?: string; onPress?: () => void }[];
  buttons.find((b) => b.style === "destructive")!.onPress!();
}

// #174: removing a member is the only action on this screen whose consequence
// lands on a third party, and it was the only one that fired unconfirmed.
test("Remove-member confirms first, and does nothing if the owner cancels", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByLabelText } = await render(<GroupDetail />);
  await fireEvent.press(getByLabelText("Remove Mate"));

  expect(mockRemoveMutate).not.toHaveBeenCalled();
  const [title, message, buttons] = alert.mock.calls.at(-1)!;
  expect(title).toBe("Remove Mate?");
  expect(message).toBe("Mate loses access to this group. You can invite them back later.");

  // Cancelling leaves the member in place.
  (buttons as { style?: string; onPress?: () => void }[]).find((b) => b.style === "cancel")?.onPress?.();
  expect(mockRemoveMutate).not.toHaveBeenCalled();

  pressDestructive(alert);
  expect(mockRemoveMutate).toHaveBeenCalledWith({ groupId: "g1", userId: "u2" }, expect.anything());
  alert.mockRestore();
});

test("the Leave-group alert carries a real message, not an empty string", async () => {
  mockRole = "member";
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByText } = await render(<GroupDetail />);
  await fireEvent.press(getByText("Leave group"));

  const [title, message] = alert.mock.calls.at(-1)!;
  expect(title).toBe("Leave this group?");
  expect(message).toBe("You'll drop off its leaderboard and challenges. You can rejoin with an invite code.");
  alert.mockRestore();
});

test("a failed Remove-member tells the user why", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByLabelText } = await render(<GroupDetail />);
  await fireEvent.press(getByLabelText("Remove Mate"));
  pressDestructive(alert);
  expect(mockRemoveMutate).toHaveBeenCalledWith(
    { groupId: "g1", userId: "u2" },
    expect.objectContaining({ onError: expect.any(Function) }),
  );
  mockRemoveMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
  alert.mockRestore();
});

test("a failed Delete-group tells the user why, and keeps onSuccess navigation", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByText } = await render(<GroupDetail />);
  await fireEvent.press(getByText("Delete group"));
  pressDestructive(alert);

  const opts = mockDeleteMutate.mock.calls[0][1];
  expect(opts.onSuccess).toEqual(expect.any(Function));
  opts.onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
  alert.mockRestore();
});

test("a failed Leave-group tells the user why, and keeps onSuccess navigation", async () => {
  mockRole = "member";
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByText } = await render(<GroupDetail />);
  await fireEvent.press(getByText("Leave group"));
  pressDestructive(alert);

  const opts = mockLeaveMutate.mock.calls[0][1];
  expect(opts.onSuccess).toEqual(expect.any(Function));
  opts.onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
  alert.mockRestore();
});
