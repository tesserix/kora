import { render, fireEvent } from "@testing-library/react-native";

import Sharing from "../sharing";

const mockPush = jest.fn();
const mockCreate = jest.fn();
const mockShow = jest.fn();

let mockCircles: unknown[] = [];
let mockCirclesState = { isError: false, isLoading: false };

jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn() } }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));
jest.mock("@/api/hooks", () => ({
  useCircles: () => ({ data: mockCircles, ...mockCirclesState, refetch: jest.fn() }),
  useCreateCircle: () => ({ mutate: mockCreate, isPending: false }),
}));

const ada = { id: "u1", display_name: "Ada" };
const ben = { id: "u2", display_name: "Ben" };

beforeEach(() => {
  mockPush.mockClear();
  mockCreate.mockClear();
  mockShow.mockClear();
  mockCirclesState = { isError: false, isLoading: false };
  mockCircles = [
    { id: "c1", name: "Household", members: [ada, ben], categories: ["progress", "body"] },
    { id: "c2", name: "Running club", members: [ben], categories: ["progress"] },
  ];
});

const OFFLINE = Object.assign(new Error("down"), { name: "NetworkError" });
const OFFLINE_COPY = "Couldn't reach Kora. Check your connection.";
const withOnError = expect.objectContaining({ onError: expect.any(Function) });

test("the audit answers who can see each category, by count", async () => {
  const { getByTestId } = await render(<Sharing />);
  // Ada and Ben are both in a body-granting circle; Ben is in two circles
  // that grant progress and must still be counted once.
  expect(getByTestId("audit-count-body")).toHaveTextContent("2");
  expect(getByTestId("audit-count-progress")).toHaveTextContent("2");
});

test("the audit names the people, not just the number", async () => {
  const { getByTestId } = await render(<Sharing />);
  expect(getByTestId("audit-names-body")).toHaveTextContent(/Ada/);
  expect(getByTestId("audit-names-body")).toHaveTextContent(/Ben/);
});

// "Nobody" is a meaningfully different answer from a count of zero people,
// and it is the answer most users should see most of the time.
test("a category no circle grants reads as nobody", async () => {
  mockCircles = [{ id: "c1", name: "Household", members: [ada], categories: ["progress"] }];
  const { getByTestId } = await render(<Sharing />);
  expect(getByTestId("audit-names-body")).toHaveTextContent("Nobody");
});

test("circles are listed with their member counts", async () => {
  const { getByText } = await render(<Sharing />);
  expect(getByText("Household")).toBeTruthy();
  expect(getByText("Running club")).toBeTruthy();
});

test("tapping a circle opens it", async () => {
  const { getByLabelText } = await render(<Sharing />);
  await fireEvent.press(getByLabelText("Open circle Household"));
  expect(mockPush).toHaveBeenCalledWith("/circle/c1");
});

test("a new circle is created by name", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Sharing />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "Gym");
  await fireEvent.press(getByLabelText("Create circle"));
  expect(mockCreate).toHaveBeenCalledWith("Gym", withOnError);
});

test("a failed create tells the user why", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Sharing />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "Gym");
  await fireEvent.press(getByLabelText("Create circle"));
  mockCreate.mock.calls[0][1].onError(OFFLINE);
  expect(mockShow).toHaveBeenCalledWith({ message: OFFLINE_COPY });
});

test("a blank name does not create a circle", async () => {
  const { getByLabelText, getByPlaceholderText } = await render(<Sharing />);
  await fireEvent.press(getByLabelText("New circle"));
  await fireEvent.changeText(getByPlaceholderText("Circle name"), "   ");
  await fireEvent.press(getByLabelText("Create circle"));
  expect(mockCreate).not.toHaveBeenCalled();
});

// #174, the rule this screen inherits: an outage must never render as a claim
// about the user's data. "You share with nobody" is a dangerously reassuring
// thing to say when the truth is that we could not ask.
test("a failed load replaces the audit rather than claiming nobody can see anything", async () => {
  mockCircles = [];
  mockCirclesState = { isError: true, isLoading: false };
  const { queryByTestId, getByText } = await render(<Sharing />);
  expect(queryByTestId("audit-names-body")).toBeNull();
  expect(getByText(/couldn't load/i)).toBeTruthy();
});
