import { fireEvent, render } from "@testing-library/react-native";
import { MealRow } from "../MealRow";

test("no star is rendered when onPinToggle is absent", async () => {
  const onPress = jest.fn();
  const { queryByLabelText } = await render(<MealRow name="Egg" slot="100g" kcal={143} onPress={onPress} />);
  expect(queryByLabelText("Pin Egg")).toBeNull();
  expect(queryByLabelText("Unpin Egg")).toBeNull();
});

test("tapping the star calls onPinToggle and NOT the row onPress", async () => {
  const onPress = jest.fn();
  const onPinToggle = jest.fn();
  const { getByLabelText } = await render(
    <MealRow name="Egg" slot="100g" kcal={143} onPress={onPress} onPinToggle={onPinToggle} pinned={false} />,
  );
  fireEvent.press(getByLabelText("Pin Egg"));
  expect(onPinToggle).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
});

test("a pinned row exposes an Unpin control", async () => {
  const { getByLabelText } = await render(
    <MealRow name="Egg" slot="100g" kcal={143} onPress={jest.fn()} onPinToggle={jest.fn()} pinned />,
  );
  getByLabelText("Unpin Egg");
});

test("tapping the bookmark calls onBookmark and NOT the row onPress", async () => {
  const onPress = jest.fn();
  const onBookmark = jest.fn();
  const { getByLabelText } = await render(
    <MealRow name="Bfast" slot="Eggs · Oats" kcal={376} onPress={onPress} onBookmark={onBookmark} bookmarked={false} />,
  );
  fireEvent.press(getByLabelText("Save Bfast"));
  expect(onBookmark).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
});

test("no bookmark control when onBookmark is absent", async () => {
  const { queryByLabelText } = await render(<MealRow name="Bfast" slot="x" kcal={1} onPress={jest.fn()} />);
  expect(queryByLabelText("Save Bfast")).toBeNull();
  expect(queryByLabelText("Edit Bfast")).toBeNull();
});
