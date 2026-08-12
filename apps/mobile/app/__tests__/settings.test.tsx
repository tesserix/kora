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
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("@/components/settings/RemindersSection", () => ({ RemindersSection: () => null }));
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
}));

// WeightReminderSection (rendered for real by this screen) reaches
// reconcileWeightReminder, which now looks the last weigh-in up through the API
// client — and firebase/auth ships ESM that Jest can't transform out of the box
// (the repo mocks it directly elsewhere for the same reason). Reconciliation is
// an inert side effect for these tests, so the module is stubbed at its edge.
jest.mock("@/reminders/reconcileWeightReminder", () => ({
  reconcileWeightReminder: jest.fn(async () => {}),
}));

const reminders = [
  { id: "a", label: "Drink water", hour: 15, minute: 0, days: [0, 1, 2, 3, 4, 5, 6], enabled: true },
  { id: "b", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5], enabled: false },
];
jest.mock("@/reminders/useCustomReminders", () => ({
  useCustomReminders: () => ({
    reminders,
    ready: true,
    addReminder: jest.fn(),
    updateReminder: jest.fn(),
    removeReminder: jest.fn(),
    toggleReminder: jest.fn(),
  }),
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

test("lists custom reminders with label + day summary and an Add row", async () => {
  const { getByText } = await render(<Settings />);
  getByText("Custom");
  getByText("Drink water");
  getByText("Every day");
  getByText("Workout");
  getByText("Mon, Wed, Fri");
  getByText("Add reminder");
});
