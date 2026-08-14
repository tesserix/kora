import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as Notifications from "expo-notifications";

import { WeightReminderSection } from "../WeightReminderSection";
import { DEFAULT_WEIGHT_PREF, loadWeightPref, saveWeightPref } from "@/reminders/weightPrefs";
import { reconcileWeightReminder } from "@/reminders/reconcileWeightReminder";

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

type ToastOptions = { message: string; actionLabel?: string; onAction?: () => void };
const mockToastShow = jest.fn<void, [ToastOptions]>();
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ show: mockToastShow }),
}));

// WeekdayPicker is wrapped (not replaced) so its real chips still render for the
// day-selection tests, while every render of the section is counted. That count
// is what makes the permission-denial revert observable: the revert's whole
// purpose is to force a re-render with a fresh pref object, because the native
// Switch has already flipped itself ON and only a re-render moves it back.
const mockWeekdayRender = jest.fn();
jest.mock("@/components/reminders/WeekdayPicker", () => {
  const React = jest.requireActual("react");
  const actual = jest.requireActual("@/components/reminders/WeekdayPicker");
  return {
    WeekdayPicker: (props: Record<string, unknown>) => {
      mockWeekdayRender();
      return React.createElement(actual.WeekdayPicker, props);
    },
  };
});

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

// Re-specced. The previous version asserted only `props.value === false` after
// a denial, which the switch already satisfies before the commit even starts —
// it passed identically with the revert line deleted, so it tested nothing.
// The behaviour that actually matters is that denial pushes a FRESH pref object
// into state: the native Switch has already animated itself ON, and only a
// re-render drags it back. So this asserts the re-render happened.
test("denied permission reverts the toggle by forcing a fresh render", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  const { getByLabelText } = await render(<WeightReminderSection />);
  await act(async () => {});

  const rendersBeforeToggle = mockWeekdayRender.mock.calls.length;

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalled());
  });

  expect(saveWeightPref).not.toHaveBeenCalled();
  expect(reconcileWeightReminder).not.toHaveBeenCalled();
  expect(mockWeekdayRender.mock.calls.length).toBeGreaterThan(rendersBeforeToggle);
  expect(getByLabelText("Weight check-in reminder").props.value).toBe(false);
});

test("blocked denial (canAskAgain false) toasts with an Open Settings action", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: false });
  const { getByLabelText } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalled());
  });

  expect(mockToastShow).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Notifications are off for Kora. Turn them on in Settings to get reminders.",
      actionLabel: "Open Settings",
      onAction: expect.any(Function),
    }),
  );
});

test("denial after a fresh prompt (canAskAgain true) toasts plainly, no action", async () => {
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  const { getByLabelText } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalled());
  });

  expect(mockToastShow).toHaveBeenCalledWith({ message: "Reminders need notification permission." });
});

// The section is editing the SCHEDULE, not recording a weigh-in. Passing an
// explicit `null` here used to mean "never weighed in", so weighing in at 06:40
// and adding a day chip at 06:50 re-armed the 07:00 reminder. Calling with no
// argument makes the reconcile look the real date up instead.
test("committing a change reconciles with no argument, so the real weigh-in is looked up", async () => {
  const { getByLabelText } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(reconcileWeightReminder).toHaveBeenCalled());
  });

  expect((reconcileWeightReminder as jest.Mock).mock.calls[0]).toEqual([]);
});

// A rejected commit must not escape into the render path as an unhandled
// rejection (a red LogBox over the settings screen in development).
test("a failing commit is caught, not left as an unhandled rejection", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  (saveWeightPref as jest.Mock).mockRejectedValue(new Error("storage full"));
  const { getByLabelText } = await render(<WeightReminderSection />);

  await act(async () => {
    fireEvent(getByLabelText("Weight check-in reminder"), "valueChange", true);
    await waitFor(() => expect(warn).toHaveBeenCalled());
  });

  expect(warn).toHaveBeenCalledWith("reminders: weight reminder commit failed", expect.any(Error));
  warn.mockRestore();
});

// Deselecting every chip while the switch still reads ON is dead state:
// nextWeightReminderAt returns null so nothing is ever scheduled, with no
// signal to the user. CustomReminderSheet guards this with the same wording.
test("deselecting the last day is refused with a message instead of committing dead state", async () => {
  (loadWeightPref as jest.Mock).mockResolvedValue({ ...DEFAULT_WEIGHT_PREF, enabled: true, days: [1] });
  const { getByTestId, getByText, queryByText } = await render(<WeightReminderSection />);
  await act(async () => {});

  expect(queryByText("Pick at least one day.")).toBeNull();

  await act(async () => {
    fireEvent.press(getByTestId("day-1"));
  });

  expect(getByText("Pick at least one day.")).toBeTruthy();
  expect(saveWeightPref).not.toHaveBeenCalled();
  expect(reconcileWeightReminder).not.toHaveBeenCalled();
});

test("selecting a different day clears the empty-selection message and commits", async () => {
  (loadWeightPref as jest.Mock).mockResolvedValue({ ...DEFAULT_WEIGHT_PREF, enabled: true, days: [1] });
  const { getByTestId, queryByText } = await render(<WeightReminderSection />);
  await act(async () => {});

  await act(async () => {
    fireEvent.press(getByTestId("day-1"));
  });
  await act(async () => {
    fireEvent.press(getByTestId("day-3"));
    await waitFor(() => expect(saveWeightPref).toHaveBeenCalled());
  });

  expect(queryByText("Pick at least one day.")).toBeNull();
  expect(saveWeightPref).toHaveBeenCalledWith(expect.objectContaining({ days: [1, 3] }));
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
