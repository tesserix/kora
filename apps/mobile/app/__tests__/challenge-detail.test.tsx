import { render, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";

import ChallengeDetailScreen from "../challenge/[id]";

const mockBack = jest.fn();
const mockJoinMutate = jest.fn();
const mockLeaveMutate = jest.fn();
const mockDeleteMutate = jest.fn();
const mockShow = jest.fn();
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
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
  useJoinChallenge: () => ({ mutate: mockJoinMutate, isPending: false }),
  useLeaveChallenge: () => ({ mutate: mockLeaveMutate, isPending: false }),
  useDeleteChallenge: () => ({ mutate: mockDeleteMutate, isPending: false }),
}));

test("renders standings, winner banner when ended, and Delete when can_delete", async () => {
  const { getByText } = await render(<ChallengeDetailScreen />);
  expect(getByText("July streak")).toBeTruthy();
  expect(getByText("Alice")).toBeTruthy();
  expect(getByText("Bob")).toBeTruthy();
  expect(getByText("1")).toBeTruthy(); // rank Numeral
  expect(getByText("2")).toBeTruthy();
  expect(getByText("6")).toBeTruthy(); // score Numeral
  expect(getByText("4")).toBeTruthy();
  expect(getByText("Alice wins")).toBeTruthy(); // trophy symbol replaces the emoji; text no longer prefixed
  expect(getByText("Leave challenge")).toBeTruthy(); // joined -> Leave
  expect(getByText("Delete challenge")).toBeTruthy(); // can_delete
});

// #83: all three challenge mutations ran with no error surface, and Join/Leave
// gate their button on isPending.
const OFFLINE = Object.assign(new Error("down"), { name: "NetworkError" });
const OFFLINE_COPY = "Couldn't reach Kora. Check your connection.";

beforeEach(() => {
  mockJoinMutate.mockClear();
  mockLeaveMutate.mockClear();
  mockDeleteMutate.mockClear();
  mockShow.mockClear();
  mockChallenge.data.joined = true;
});

test("a failed Leave-challenge tells the user why", async () => {
  const { getByText } = await render(<ChallengeDetailScreen />);
  await fireEvent.press(getByText("Leave challenge"));
  expect(mockLeaveMutate).toHaveBeenCalledWith(
    { challengeId: "c1", groupId: "g1" },
    expect.objectContaining({ onError: expect.any(Function) }),
  );
  mockLeaveMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

test("a failed Join-challenge tells the user why", async () => {
  mockChallenge.data.joined = false;
  const { getByText } = await render(<ChallengeDetailScreen />);
  await fireEvent.press(getByText("Join challenge"));
  mockJoinMutate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

test("a failed Delete-challenge tells the user why, and keeps onSuccess navigation", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const { getByText } = await render(<ChallengeDetailScreen />);
  await fireEvent.press(getByText("Delete challenge"));
  const buttons = alert.mock.calls.at(-1)?.[2] as { style?: string; onPress?: () => void }[];
  buttons.find((b) => b.style === "destructive")!.onPress!();

  const opts = mockDeleteMutate.mock.calls[0][1];
  expect(opts.onSuccess).toEqual(expect.any(Function));
  opts.onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
  alert.mockRestore();
});
