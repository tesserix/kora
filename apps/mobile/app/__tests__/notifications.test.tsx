import { fireEvent, render } from "@testing-library/react-native";

const mockPush = jest.fn();
const mockMarkAll = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("@/api/hooks", () => ({
  useNotifications: () => ({
    data: [
      { id: "n1", type: "friend_request", actor_id: "u2", actor_name: "Alice", read: false, created_at: "2026-07-26T00:00:00Z" },
      { id: "n2", type: "challenge_created", actor_id: "u3", actor_name: "Bob", entity_id: "c9", read: true, created_at: "2026-07-25T00:00:00Z" },
    ],
  }),
  useMarkAllRead: () => ({ mutate: mockMarkAll }),
}));

import NotificationsScreen from "../notifications";

beforeEach(() => {
  mockPush.mockReset();
  mockMarkAll.mockReset();
});

test("marks all read on mount and renders per-type messages", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  expect(mockMarkAll).toHaveBeenCalled();
  expect(getByText("Alice sent you a friend request")).toBeTruthy();
  expect(getByText("Bob started a challenge")).toBeTruthy();
});

test("tapping a challenge notification deep-links to the challenge", async () => {
  const { getByText } = await render(<NotificationsScreen />);
  await fireEvent.press(getByText("Bob started a challenge"));
  expect(mockPush).toHaveBeenCalledWith("/challenge/c9");
});
