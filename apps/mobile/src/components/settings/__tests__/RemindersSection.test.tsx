import { fireEvent, render } from "@testing-library/react-native";

const mockSetSlot = jest.fn();
jest.mock("@/reminders/useReminderPrefs", () => ({
  useReminderPrefs: () => ({
    prefs: {
      breakfast: { enabled: true, hour: 8, minute: 0 },
      lunch: { enabled: false, hour: 12, minute: 30 },
      dinner: { enabled: true, hour: 18, minute: 30 },
      snack: { enabled: false, hour: 15, minute: 0 },
    },
    setSlot: mockSetSlot,
    ready: true,
  }),
}));

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");

import { RemindersSection } from "../RemindersSection";

beforeEach(() => mockSetSlot.mockReset());

test("renders a row per meal and toggling calls setSlot with the flipped enabled flag", async () => {
  const { getByText, getByTestId } = await render(<RemindersSection />);
  getByText("Breakfast");
  getByText("Lunch");
  fireEvent(getByTestId("reminder-switch-lunch"), "valueChange", true);
  expect(mockSetSlot).toHaveBeenCalledWith("lunch", expect.objectContaining({ enabled: true, hour: 12, minute: 30 }));
});

test("tapping an enabled meal's time opens the sheet, and Done applies the seeded time", async () => {
  const { getByLabelText, getByText } = await render(<RemindersSection />);
  await fireEvent.press(getByLabelText("Breakfast time"));
  expect(getByText("Done")).toBeTruthy();
  await fireEvent.press(getByText("Done"));
  expect(mockSetSlot).toHaveBeenCalledWith("breakfast", expect.objectContaining({ enabled: true, hour: 8, minute: 0 }));
});
