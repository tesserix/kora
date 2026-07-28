import { render, waitFor } from "@testing-library/react-native";

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("@/components/settings/RemindersSection", () => ({ RemindersSection: () => null }));

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

import RemindersScreen from "../reminders";

test("lists custom reminders with label + day summary and an Add row", async () => {
  const { getByText } = await render(<RemindersScreen />);
  getByText("Custom");
  getByText("Drink water");
  getByText("Every day");
  getByText("Workout");
  getByText("Mon, Wed, Fri");
  getByText("Add reminder");
});
