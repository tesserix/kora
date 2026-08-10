import { render, fireEvent } from "@testing-library/react-native";

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockSetSystem = jest.fn();

jest.mock("expo-router", () => ({
  router: {
    back: (...a: unknown[]) => mockBack(...a),
    push: (...a: unknown[]) => mockPush(...a),
  },
}));
jest.mock("@/units", () => ({
  useUnits: () => ({ system: "metric", setSystem: mockSetSystem }),
}));

import Settings from "../settings";

beforeEach(() => {
  mockBack.mockClear();
  mockPush.mockClear();
  mockSetSystem.mockClear();
});

test("renders the Settings title and both unit segments", async () => {
  const { getByText } = await render(<Settings />);
  expect(getByText("Settings")).toBeTruthy();
  expect(getByText("Metric")).toBeTruthy();
  expect(getByText("Imperial")).toBeTruthy();
});

test("tapping Imperial calls setSystem with imperial", async () => {
  const { getByText } = await render(<Settings />);
  fireEvent.press(getByText("Imperial"));
  expect(mockSetSystem).toHaveBeenCalledWith("imperial");
});

test("settings offers a route to the reminders screen", async () => {
  const { getByLabelText } = await render(<Settings />);
  fireEvent.press(getByLabelText("Reminders"));
  expect(mockPush).toHaveBeenCalledWith("/reminders");
});
