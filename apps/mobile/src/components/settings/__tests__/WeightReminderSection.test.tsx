import { fireEvent, render } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";

jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");

jest.mock("@/reminders/weightPrefs", () => ({
  ...jest.requireActual("@/reminders/weightPrefs"),
  loadWeightPref: jest.fn(),
  saveWeightPref: jest.fn(),
}));

jest.mock("@/reminders/reconcileWeightReminder", () => ({
  reconcileWeightReminder: jest.fn(),
}));

import { WeightReminderSection } from "../WeightReminderSection";
import { DEFAULT_WEIGHT_PREF, loadWeightPref, saveWeightPref } from "@/reminders/weightPrefs";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";

beforeEach(() => {
  jest.clearAllMocks();
  (loadWeightPref as jest.Mock).mockResolvedValue(DEFAULT_WEIGHT_PREF);
  (saveWeightPref as jest.Mock).mockResolvedValue(undefined);
  (reconcileWeightReminder as jest.Mock).mockResolvedValue(undefined);
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});

test("the section renders disabled by default", async () => {
  const { getByLabelText } = await render(<WeightReminderSection />);
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});

test("enabling persists the pref and re-arms the schedule", async () => {
  const { getByLabelText } = await render(<WeightReminderSection />);

  await fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);

  expect(saveWeightPref).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  expect(reconcileWeightReminder).toHaveBeenCalled();
});

test("denied permission leaves the toggle off", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const { getByLabelText } = await render(<WeightReminderSection />);

  await fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);

  expect(saveWeightPref).not.toHaveBeenCalled();
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});
