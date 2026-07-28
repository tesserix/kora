import { fireEvent, render } from "@testing-library/react-native";

jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("@/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? children : null) }));

import { CustomReminderSheet } from "../CustomReminderSheet";

const noop = () => {};

test("add mode: entering a label and saving calls onSave with a null id and trimmed label", async () => {
  const onSave = jest.fn();
  const { getByPlaceholderText, getByText } = await render(
    <CustomReminderSheet visible editing={null} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  await fireEvent.changeText(getByPlaceholderText("Reminder label"), "  Drink water  ");
  await fireEvent.press(getByText("Save"));
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ label: "Drink water", days: [0, 1, 2, 3, 4, 5, 6], enabled: true }),
    null,
  );
});

test("saving with an empty label shows an error and does not call onSave", async () => {
  const onSave = jest.fn();
  const { getByText } = await render(
    <CustomReminderSheet visible editing={null} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  await fireEvent.press(getByText("Save"));
  expect(onSave).not.toHaveBeenCalled();
  getByText("Enter a label.");
});

test("edit mode: tapping Delete calls onDelete with the id", async () => {
  const onDelete = jest.fn();
  const editing = { id: "a", label: "Workout", hour: 7, minute: 30, days: [1, 3, 5] as any, enabled: true };
  const { getByText } = await render(
    <CustomReminderSheet visible editing={editing} onClose={noop} onSave={noop} onDelete={onDelete} />,
  );
  await fireEvent.press(getByText("Delete reminder"));
  expect(onDelete).toHaveBeenCalledWith("a");
});

test("deselecting all days then saving shows the days error", async () => {
  const onSave = jest.fn();
  const editing = { id: "a", label: "Workout", hour: 7, minute: 30, days: [1] as any, enabled: true };
  const { getByText, getByTestId } = await render(
    <CustomReminderSheet visible editing={editing} onClose={noop} onSave={onSave} onDelete={noop} />,
  );
  await fireEvent.press(getByTestId("day-1")); // toggle Monday off -> no days selected
  await fireEvent.press(getByText("Save"));
  expect(onSave).not.toHaveBeenCalled();
  getByText("Pick at least one day.");
});
