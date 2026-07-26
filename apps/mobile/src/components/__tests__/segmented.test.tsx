import { fireEvent, render } from "@testing-library/react-native";
import * as Haptics from "expo-haptics";
import { Segmented } from "@/components/Segmented";

const options = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];

test("renders all option labels", async () => {
  const { getByText } = await render(<Segmented options={options} value="week" onChange={jest.fn()} />);
  expect(getByText("Week")).toBeTruthy();
  expect(getByText("Month")).toBeTruthy();
});

test("pressing a segment fires onChange with its key and triggers the selection haptic", async () => {
  const onChange = jest.fn();
  const { getByRole } = await render(<Segmented options={options} value="week" onChange={onChange} />);
  fireEvent.press(getByRole("tab", { name: "Month" }));
  expect(onChange).toHaveBeenCalledWith("month");
  expect(Haptics.selectionAsync).toHaveBeenCalled();
});

test("marks exactly the selected segment via accessibilityState", async () => {
  const { getAllByRole } = await render(<Segmented options={options} value="month" onChange={jest.fn()} />);
  const tabs = getAllByRole("tab");
  const selected = tabs.filter((tab) => tab.props.accessibilityState?.selected);
  expect(selected).toHaveLength(1);
  expect(selected[0].props.accessibilityLabel ?? selected[0].props.children).toBeTruthy();
});
