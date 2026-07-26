import { fireEvent, render } from "@testing-library/react-native";
import { GroupedSection, Row } from "@/components/GroupedList";

function flattenStyle(style: unknown): Record<string, unknown> {
  const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
  return Object.assign({}, ...flat.filter(Boolean));
}

test("renders an uppercase caption header", async () => {
  const { getByText } = await render(
    <GroupedSection header="today">
      <Row title="Breakfast" />
    </GroupedSection>,
  );
  const header = getByText("today");
  expect(flattenStyle(header.props.style).textTransform).toBe("uppercase");
});

test("inserts N-1 hairline separators between N children", async () => {
  const { getAllByTestId } = await render(
    <GroupedSection>
      <Row title="Breakfast" />
      <Row title="Lunch" />
      <Row title="Dinner" />
    </GroupedSection>,
  );
  expect(getAllByTestId("row-sep")).toHaveLength(2);
});

test("Row fires onPress", async () => {
  const onPress = jest.fn();
  const { getByRole } = await render(<Row title="Add water" onPress={onPress} />);
  fireEvent.press(getByRole("button", { name: "Add water" }));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test("Row renders detail text", async () => {
  const { getByText } = await render(<Row title="Steps" detail="8,204" />);
  expect(getByText("8,204")).toBeTruthy();
});
