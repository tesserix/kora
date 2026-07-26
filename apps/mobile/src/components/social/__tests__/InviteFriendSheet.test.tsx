import { render, fireEvent } from "@testing-library/react-native";
import { InviteFriendSheet } from "../InviteFriendSheet";

const mockInvite = jest.fn();
const mockUseFriends = jest.fn();
jest.mock("@/api/hooks", () => ({
  useInviteToGroup: () => ({ mutate: mockInvite, isPending: false }),
  useFriends: () => mockUseFriends(),
}));

beforeEach(() => {
  mockInvite.mockReset();
  mockUseFriends.mockReturnValue({
    data: [
      { id: "f1", display_name: "Alice" },
      { id: "f2", display_name: "Bob" },
    ],
  });
});

test("lists friends who aren't members and invites on tap", async () => {
  const onClose = jest.fn();
  const { getByText, queryByText } = await render(
    <InviteFriendSheet visible groupId="g1" memberIds={["f2"]} onClose={onClose} />,
  );
  expect(getByText("Alice")).toBeTruthy();
  expect(queryByText("Bob")).toBeNull(); // f2 is already a member
  await fireEvent.press(getByText("Alice"));
  expect(mockInvite).toHaveBeenCalledWith({ groupId: "g1", userId: "f1" }, expect.anything());
});

test("shows an empty state when no friends are eligible", async () => {
  mockUseFriends.mockReturnValue({ data: [{ id: "f1", display_name: "Alice" }] });
  const { getByText, queryByText } = await render(
    <InviteFriendSheet visible groupId="g1" memberIds={["f1"]} onClose={jest.fn()} />,
  );
  expect(queryByText("Alice")).toBeNull();
  expect(getByText("No friends to invite. Everyone's already in, or add friends first.")).toBeTruthy();
});

test("shows an inline error and stays open when the invite fails", async () => {
  mockInvite.mockImplementation((_vars, opts) => opts.onError());
  const onClose = jest.fn();
  const { getByText } = await render(
    <InviteFriendSheet visible groupId="g1" memberIds={[]} onClose={onClose} />,
  );
  await fireEvent.press(getByText("Alice"));
  expect(getByText("Couldn't invite. Try again.")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
