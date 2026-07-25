import { render, fireEvent } from "@testing-library/react-native";

const mockAcceptMutate = jest.fn();
const mockDeclineMutate = jest.fn();
const mockUnfriendMutate = jest.fn();

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
jest.mock("@/api/hooks", () => ({
  useFriends: () => ({ data: [{ id: "u1", display_name: "Ada" }] }),
  useFriendRequests: () => ({ data: { incoming: [{ id: "r1", user: { id: "u2", display_name: "Ben" } }], outgoing: [] } }),
  useAcceptRequest: () => ({ mutate: mockAcceptMutate, isPending: false }),
  useDeclineRequest: () => ({ mutate: mockDeclineMutate, isPending: false }),
  useUnfriend: () => ({ mutate: mockUnfriendMutate, isPending: false }),
  useSendFriendRequest: () => ({ mutate: jest.fn(), isPending: false }),
  useMyFriendCode: () => ({ data: { code: "ABC123XY", link: "mobile://friend/ABC123XY" } }),
}));

import Friends from "../friends";

beforeEach(() => { mockAcceptMutate.mockClear(); mockDeclineMutate.mockClear(); });

test("renders friends and incoming requests; Accept calls the hook with the request id", async () => {
  const { getByText, getByLabelText } = await render(<Friends />);
  expect(getByText("Ada")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
  await fireEvent.press(getByLabelText("Accept request from Ben"));
  expect(mockAcceptMutate).toHaveBeenCalledWith("r1");
});
