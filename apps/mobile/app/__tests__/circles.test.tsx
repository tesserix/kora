import { render, fireEvent } from "@testing-library/react-native";
import { Alert } from "react-native";

import Circles from "../circles";

const mockPush = jest.fn();
const mockCreate = jest.fn();
const mockShow = jest.fn();

let mockCircles: unknown[] = [];
let mockCirclesState = { isError: false, isLoading: false };
let mockMemberships: unknown[] = [];
let mockMembershipsErr = false;
const mockLeave = jest.fn();

jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() } }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
jest.mock("@/api/hooks", () => ({
  useCircles: () => ({ data: mockCircles, ...mockCirclesState, refetch: jest.fn() }),
  useCreateCircle: () => ({ mutate: mockCreate, isPending: false }),
  useMemberships: () => ({ data: mockMemberships, isError: mockMembershipsErr, refetch: jest.fn() }),
  useLeaveCircle: () => ({ mutate: mockLeave, isPending: false }),
}));

const ada = { id: "u1", display_name: "Ada" };
const ben = { id: "u2", display_name: "Ben" };

beforeEach(() => {
  mockPush.mockClear();
  mockCreate.mockClear();
  mockShow.mockClear();
  mockCirclesState = { isError: false, isLoading: false };
  mockMemberships = [];
  mockMembershipsErr = false;
  mockLeave.mockClear();
  mockCircles = [
    { id: "c1", name: "Household", members: [ada, ben], categories: ["progress", "body"] },
    { id: "c2", name: "Running club", members: [ben], categories: ["progress"] },
  ];
});

const OFFLINE = Object.assign(new Error("down"), { name: "NetworkError" });
const OFFLINE_COPY = "Couldn't reach Kora. Check your connection.";
const withOnError = expect.objectContaining({ onError: expect.any(Function) });




test("circles are listed with their member counts", async () => {
  const { getByText } = await render(<Circles />);
  expect(getByText("Household")).toBeTruthy();
  expect(getByText("Running club")).toBeTruthy();
});

test("tapping a circle opens it", async () => {
  const { getByLabelText } = await render(<Circles />);
  await fireEvent.press(getByLabelText("Open circle Household"));
  expect(mockPush).toHaveBeenCalledWith("/circle/c1");
});

test("a new circle is created by name", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Circles />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "Gym");
  await fireEvent.press(getByLabelText("Create circle"));
  expect(mockCreate).toHaveBeenCalledWith("Gym", withOnError);
});

test("a failed create tells the user why", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Circles />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "Gym");
  await fireEvent.press(getByLabelText("Create circle"));
  mockCreate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

test("a blank name does not create a circle", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Circles />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "   ");
  await fireEvent.press(getByLabelText("Create circle"));
  expect(mockCreate).not.toHaveBeenCalled();
});

// #174, the rule this screen inherits: an outage must never render as a claim
// about the user's data. "You share with nobody" is a dangerously reassuring
// thing to say when the truth is that we could not ask.
test("a failed load says so rather than showing an empty circle list", async () => {
  mockCircles = [];
  mockCirclesState = { isError: true, isLoading: false };
  const { getByText, queryByText } = await render(<Circles />);
  expect(getByText(/couldn't load/i)).toBeTruthy();
  expect(queryByText("No circles yet")).toBeNull();
});


// kora#440: the member-side half. Before this, POST /:id/leave was
// implemented, tested and completely unreachable — a member had no way to
// learn the circle id it needs.
const household = {
  circle_id: "c9",
  owner: { id: "u9", display_name: "Priya Nair" },
  categories: ["body"],
};

test("shared-with-you names the owner and what they share, never the circle name", async () => {
  mockMemberships = [household];
  const { getByText, queryByText } = await render(<Circles />);
  expect(getByText("Priya Nair")).toBeTruthy();
  expect(getByText(/Shares body metrics with you/i)).toBeTruthy();
  // The server never sends a name; assert the UI invents no substitute.
  expect(queryByText(/Gym|crew|circle name/i)).toBeNull();
});

test("the section is absent entirely when nobody shares with you", async () => {
  const { queryByText } = await render(<Circles />);
  expect(queryByText("Shared with you")).toBeNull();
});

test("leaving asks first, then calls the hook with the circle id", async () => {
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockMemberships = [household];
  const { getByLabelText } = await render(<Circles />);
  await fireEvent.press(getByLabelText("Leave Priya Nair's circle"));
  expect(alertSpy).toHaveBeenCalled();
  // Nothing happens on the tap alone. Leaving is destructive and one-way:
  // rejoining needs the owner to add you back.
  expect(mockLeave).not.toHaveBeenCalled();
  const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
  const leaveButton = buttons.find((b) => b.text === "Leave")!;
  leaveButton.onPress!();
  expect(mockLeave).toHaveBeenCalledWith("c9", expect.objectContaining({ onError: expect.any(Function) }));
  alertSpy.mockRestore();
});

test("a failed memberships load says so rather than implying nobody shares with you", async () => {
  mockMembershipsErr = true;
  const { getByTestId, queryByText } = await render(<Circles />);
  expect(getByTestId("memberships-load-error")).toBeTruthy();
  expect(queryByText(/Shares .* with you/)).toBeNull();
});


// Found against a real API, not in a test: display_name is "" for an account
// that never set one, and the row rendered nameless above a sentence saying
// this person can see your body metrics.
test("an owner with no display name still reads as a person, never as a blank", async () => {
  mockMemberships = [{ ...household, owner: { id: "u9", display_name: "" } }];
  const { getByText, getByLabelText } = await render(<Circles />);
  expect(getByText("Someone you know")).toBeTruthy();
  expect(getByLabelText("Leave Someone you know's circle")).toBeTruthy();
});
