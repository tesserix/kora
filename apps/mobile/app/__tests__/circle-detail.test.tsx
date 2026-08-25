import { render, fireEvent } from "@testing-library/react-native";

import CircleDetail from "../circle/[id]";

const mockSetCategories = jest.fn();
const mockAddMember = jest.fn();
const mockRemoveMember = jest.fn();
const mockDelete = jest.fn();
const mockShow = jest.fn();
const mockBack = jest.fn();

let mockCircles: unknown[] = [];
let mockFriends: unknown[] = [];

jest.mock("expo-router", () => ({
  router: { back: (...a: unknown[]) => mockBack(...a), replace: jest.fn() },
  useLocalSearchParams: () => ({ id: "c1" }),
}));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
jest.mock("@/api/hooks", () => ({
  useCircles: () => ({ data: mockCircles, isError: false, refetch: jest.fn() }),
  useFriends: () => ({ data: mockFriends }),
  useSetCircleCategories: () => ({ mutate: mockSetCategories, isPending: false }),
  useAddCircleMember: () => ({ mutate: mockAddMember, isPending: false }),
  useRemoveCircleMember: () => ({ mutate: mockRemoveMember, isPending: false }),
  useDeleteCircle: () => ({ mutate: mockDelete, isPending: false }),
}));

const ada = { id: "u1", display_name: "Ada" };
const ben = { id: "u2", display_name: "Ben" };
const cleo = { id: "u3", display_name: "Cleo" };

beforeEach(() => {
  [mockSetCategories, mockAddMember, mockRemoveMember, mockDelete, mockShow, mockBack].forEach((m) => m.mockClear());
  mockCircles = [{ id: "c1", name: "Household", members: [ada, ben], categories: ["progress"] }];
  mockFriends = [ada, ben, cleo];
});

const withOnError = expect.objectContaining({ onError: expect.any(Function) });

test("shows the circle's members", async () => {
  const { getByText } = await render(<CircleDetail />);
  expect(getByText("Ada")).toBeTruthy();
  expect(getByText("Ben")).toBeTruthy();
});

// progress is a plain toggle. Sharing a streak is not the same act as sharing
// a body-fat percentage, and the asymmetry below is the spec's, not a
// suggestion.
test("progress toggles straight through, with no confirmation", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [ada, ben], categories: [] }];
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Progress"), "valueChange", true);
  expect(mockSetCategories).toHaveBeenCalledWith({ circleId: "c1", categories: ["progress"] }, withOnError);
});

test("granting body asks first, and does not grant until confirmed", async () => {
  const { getByLabelText, getByTestId } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Body metrics"), "valueChange", true);
  expect(mockSetCategories).not.toHaveBeenCalled();
  expect(getByTestId("body-confirm-names")).toBeTruthy();
  await fireEvent.press(getByLabelText("Confirm sharing body metrics"));
  expect(mockSetCategories).toHaveBeenCalledWith(
    { circleId: "c1", categories: ["progress", "body"] },
    withOnError,
  );
});

// The confirmation must name the people, as an actual list. "2 members" is
// exactly the abstraction that lets someone agree to something they have not
// pictured.
test("the body confirmation names every member it will expose", async () => {
  const { getByLabelText, getByTestId } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Body metrics"), "valueChange", true);
  const named = getByTestId("body-confirm-names");
  expect(named).toHaveTextContent(/Ada/);
  expect(named).toHaveTextContent(/Ben/);
  expect(named).not.toHaveTextContent(/2 members/);
});

test("cancelling the body confirmation grants nothing", async () => {
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Body metrics"), "valueChange", true);
  await fireEvent.press(getByLabelText("Cancel sharing body metrics"));
  expect(mockSetCategories).not.toHaveBeenCalled();
});

// Revoking is never the risky direction, so it must never be gated behind a
// confirmation. A permission surface that makes STOPPING harder than starting
// is working against the person it exists for.
test("revoking body takes effect immediately, with no confirmation", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [ada, ben], categories: ["progress", "body"] }];
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Body metrics"), "valueChange", false);
  expect(mockSetCategories).toHaveBeenCalledWith({ circleId: "c1", categories: ["progress"] }, withOnError);
});

// An empty circle exposes nobody, so there is nothing to confirm — but the
// grant must still be recorded, or adding a member later would silently share
// body metrics the owner never turned on.
test("granting body on an empty circle needs no confirmation but still grants", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [], categories: [] }];
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Body metrics"), "valueChange", true);
  expect(mockSetCategories).toHaveBeenCalledWith({ circleId: "c1", categories: ["body"] }, withOnError);
});

test("only friends who are not already members can be added", async () => {
  const { getByLabelText, queryByLabelText } = await render(<CircleDetail />);
  await fireEvent.press(getByLabelText("Add someone"));
  expect(queryByLabelText("Add Cleo to Household")).toBeTruthy();
  expect(queryByLabelText("Add Ada to Household")).toBeNull();
});

test("adding a friend calls the hook with the circle and the friend", async () => {
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent.press(getByLabelText("Add someone"));
  await fireEvent.press(getByLabelText("Add Cleo to Household"));
  expect(mockAddMember).toHaveBeenCalledWith({ circleId: "c1", userId: "u3" }, withOnError);
});

test("removing a member calls the hook with the circle and the member", async () => {
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent.press(getByLabelText("Remove Ada from Household"));
  expect(mockRemoveMember).toHaveBeenCalledWith({ circleId: "c1", userId: "u1" }, withOnError);
});

test("a failed category change tells the user why", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [ada], categories: [] }];
  const { getByLabelText } = await render(<CircleDetail />);
  await fireEvent(getByLabelText("Share Progress"), "valueChange", true);
  mockSetCategories.mock.calls[0][1].onError(Object.assign(new Error("down"), { name: "NetworkError" }));
  expect(mockShow).toHaveBeenCalledWith({ message: "Couldn't reach Kora. Check your connection." });
});

// A circle the server has never heard of, or that another device deleted,
// must not render as an empty circle you can still grant categories to.
test("a circle that is not in the list renders as gone, not as empty", async () => {
  mockCircles = [];
  const { queryByLabelText, getByText } = await render(<CircleDetail />);
  expect(queryByLabelText("Share Body metrics")).toBeNull();
  expect(getByText(/not found/i)).toBeTruthy();
});
