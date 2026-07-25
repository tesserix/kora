import { render } from "@testing-library/react-native";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({ router: { back: mockBack }, useLocalSearchParams: () => ({ id: "c1" }) }));

const mockChallenge = {
  data: {
    id: "c1",
    group_id: "g1",
    title: "July streak",
    metric: "logged",
    status: "ended",
    start_date: "2026-07-01",
    end_date: "2026-07-08",
    joined: true,
    can_delete: true,
    standings: [
      { user_id: "u1", display_name: "Alice", score: 6 },
      { user_id: "u2", display_name: "Bob", score: 4 },
    ],
    winner: { user_id: "u1", display_name: "Alice", score: 6 },
  },
};
jest.mock("@/api/hooks", () => ({
  useChallenge: () => mockChallenge,
  useJoinChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useLeaveChallenge: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteChallenge: () => ({ mutate: jest.fn(), isPending: false }),
}));

import ChallengeDetailScreen from "../challenge/[id]";

test("renders standings, winner banner when ended, and Delete when can_delete", async () => {
  const { getByText } = await render(<ChallengeDetailScreen />);
  expect(getByText("July streak")).toBeTruthy();
  expect(getByText("1. Alice")).toBeTruthy();
  expect(getByText("2. Bob")).toBeTruthy();
  expect(getByText("🏆 Alice wins")).toBeTruthy();
  expect(getByText("Leave challenge")).toBeTruthy(); // joined -> Leave
  expect(getByText("Delete challenge")).toBeTruthy(); // can_delete
});
