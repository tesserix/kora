import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
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

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(saveWeightPref).toHaveBeenCalled());
  });

  expect(saveWeightPref).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  expect(reconcileWeightReminder).toHaveBeenCalled();
});

test("denied permission leaves the toggle off", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const { getByLabelText } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalled());
  });

  expect(saveWeightPref).not.toHaveBeenCalled();
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});

// Regression: commit() used to compute `next` from a pre-await snapshot, so a
// day-change resolving while the enabling permission dialog was still pending
// would get silently overwritten once the toggle's stale snapshot landed.
// commit() must instead build `next` from the current committed pref AFTER
// the permission await resolves, so both edits survive.
test("a day change while enabling is still awaiting permission is not lost", async () => {
  let resolvePermission!: (result: { granted: boolean }) => void;
  (Notifications.getPermissionsAsync as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      resolvePermission = resolve;
    }),
  );

  const { getByLabelText, getByTestId } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    fireEvent.press(getByTestId("day-2"));
    resolvePermission({ granted: true });
    await waitFor(() =>
      expect(saveWeightPref).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, days: expect.arrayContaining([1, 2]) }),
      ),
    );
  });
});

// Regression: commit() used to call getPermissionsAsync on every edit,
// including day/time changes on an already-enabled reminder. Only the
// off→on transition should ever prompt for permission.
test("editing days on an already-enabled reminder does not re-check permission", async () => {
  (loadWeightPref as jest.Mock).mockResolvedValue({ ...DEFAULT_WEIGHT_PREF, enabled: true });
  const { getByTestId } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent.press(getByTestId("day-2"));
    await waitFor(() => expect(saveWeightPref).toHaveBeenCalled());
  });

  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(saveWeightPref).toHaveBeenCalledWith(expect.objectContaining({ days: expect.arrayContaining([1, 2]) }));
});
