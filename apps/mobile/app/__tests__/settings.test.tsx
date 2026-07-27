import { render, fireEvent } from "@testing-library/react-native";

const mockBack = jest.fn();
const mockSetSystem = jest.fn();

jest.mock("expo-router", () => ({ router: { back: (...a: unknown[]) => mockBack(...a) } }));
jest.mock("@/units", () => ({
  useUnits: () => ({ system: "metric", setSystem: mockSetSystem }),
}));

import Settings from "../settings";

beforeEach(() => {
  mockBack.mockClear();
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
