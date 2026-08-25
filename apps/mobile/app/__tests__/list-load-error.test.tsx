import { render, fireEvent } from "@testing-library/react-native";

import Friends from "../friends";
import Groups from "../groups";
import NotificationsScreen from "../notifications";
import ChallengeDetailScreen from "../challenge/[id]";

// #174 item 1, systemic version: four screens read only `data`, so an outage
// rendered as "you have nothing" — an empty friends list, no groups, an empty
// inbox, and a challenge with no standings. A list screen does not need the
// full banner treatment Home uses; an inline notice with a retry is enough, so
// long as the empty state it replaces never shows on error.

const mockFriends = jest.fn();
const mockGroups = jest.fn();
const mockNotifications = jest.fn();
const mockChallenge = jest.fn();
const mockRefetch = jest.fn();

jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: "c1" }),
}));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: jest.fn() }) }));
jest.mock("@/api/hooks", () => ({
  useFriends: () => mockFriends(),
  useFriendRequests: () => ({ data: undefined, isError: true, refetch: jest.fn() }),
  useAcceptRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useUnfriend: () => ({ mutate: jest.fn(), isPending: false }),
  useSendFriendRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useMyFriendCode: () => ({ data: undefined }),
  useFriendsProgress: () => ({ data: undefined }),
  useGroups: () => mockGroups(),
  useCreateGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useJoinGroup: () => ({ mutate: jest.fn(), isPending: false }),
  useNotifications: () => mockNotifications(),
  useMarkAllRead: () => ({ mutate: jest.fn() }),
  useChallenge: () => mockChallenge(),
  useJoinChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useLeaveChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteChallenge: () => ({ mutate: jest.fn(), isPending: false }),
}));

const failed = { data: undefined, isError: true, refetch: mockRefetch };

beforeEach(() => {
  mockRefetch.mockClear();
  mockFriends.mockReturnValue(failed);
  mockGroups.mockReturnValue(failed);
  mockNotifications.mockReturnValue(failed);
  mockChallenge.mockReturnValue(failed);
});

test("a failed friends fetch says so instead of 'No friends yet'", async () => {
  const { getByText, queryByText } = await render(<Friends />);
  expect(getByText("Couldn't load your friends.")).toBeTruthy();
  expect(queryByText("No friends yet")).toBeNull();
});

test("Retry refetches the friends list", async () => {
  const { getAllByLabelText } = await render(<Friends />);
  await fireEvent.press(getAllByLabelText("Retry")[0]);
  expect(mockRefetch).toHaveBeenCalled();
});

test("a failed groups fetch says so instead of 'No groups yet'", async () => {
  const { getByText, queryByText } = await render(<Groups />);
  expect(getByText("Couldn't load your groups.")).toBeTruthy();
  expect(queryByText("No groups yet")).toBeNull();
});

test("a failed notifications fetch says so instead of 'Nothing yet'", async () => {
  const { getByText, queryByText } = await render(<NotificationsScreen />);
  expect(getByText("Couldn't load your notifications.")).toBeTruthy();
  expect(queryByText("Nothing yet")).toBeNull();
});

test("a failed challenge fetch says so instead of an empty leaderboard", async () => {
  const { getByText, queryByText } = await render(<ChallengeDetailScreen />);
  expect(getByText("Couldn't load this challenge.")).toBeTruthy();
  expect(queryByText("No one has joined yet.")).toBeNull();
});

// Over-correction guard: genuinely empty lists must keep their empty states.
test("resolved empty lists still show their empty states", async () => {
  mockFriends.mockReturnValue({ data: [], isError: false, refetch: mockRefetch });
  mockGroups.mockReturnValue({ data: [], isError: false, refetch: mockRefetch });
  mockNotifications.mockReturnValue({ data: [], isError: false, refetch: mockRefetch });

  expect((await render(<Friends />)).getByText("No friends yet")).toBeTruthy();
  expect((await render(<Groups />)).getByText("No groups yet")).toBeTruthy();
  expect((await render(<NotificationsScreen />)).getByText("Nothing yet")).toBeTruthy();
});
