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

// Segments are equal-width (flex: 1), so a label longer than its share of the
// track used to wrap onto a second line and drag the whole control's height
// with it — "Usual meals" in the five-tab food-memory row did exactly that.
// iOS segmented controls shorten their text, they never reflow.
test("keeps every label on one line so a long one cannot grow the control", async () => {
  const longOptions = [
    { key: "saved", label: "Saved" },
    { key: "usual_meals", label: "Usual meals" },
  ];
  const { getByText } = await render(<Segmented options={longOptions} value="saved" onChange={jest.fn()} />);
  expect(getByText("Usual meals").props.numberOfLines).toBe(1);
  expect(getByText("Saved").props.numberOfLines).toBe(1);
});

test("marks exactly the selected segment via accessibilityState", async () => {
  const { getAllByRole } = await render(<Segmented options={options} value="month" onChange={jest.fn()} />);
  const tabs = getAllByRole("tab");
  const selected = tabs.filter((tab) => tab.props.accessibilityState?.selected);
  expect(selected).toHaveLength(1);
  expect(selected[0].props.accessibilityLabel ?? selected[0].props.children).toBeTruthy();
});
