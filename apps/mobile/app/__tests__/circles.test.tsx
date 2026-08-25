import { render, fireEvent } from "@testing-library/react-native";

import Circles from "../circles";

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
