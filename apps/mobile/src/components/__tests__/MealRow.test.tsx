import { fireEvent, render } from "@testing-library/react-native";
import { selectionAsync } from "expo-haptics";
import { MealRow } from "../MealRow";
import { AppText } from "../Text";

beforeEach(() => (selectionAsync as jest.Mock).mockClear());

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

// A pending queued row has nothing to open, so the diary renders it with no
// onPress. Announcing it as a button and buzzing under the finger promises an
// interaction that does not exist.
test("a row with no onPress is neither announced nor felt as a button", async () => {
  const { queryByRole, getByTestId } = await render(<MealRow name="Egg" slot="100g" kcal={143} />);
  expect(queryByRole("button")).toBeNull();

  fireEvent.press(getByTestId("meal-row"));
  expect(selectionAsync).not.toHaveBeenCalled();
});

test("a row with an onPress is still a button and still gives selection feedback", async () => {
  const onPress = jest.fn();
  const { getByRole } = await render(<MealRow name="Egg" slot="100g" kcal={143} onPress={onPress} />);

  fireEvent.press(getByRole("button"));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(selectionAsync).toHaveBeenCalled();
});

test("a badge renders alongside the kcal figure", async () => {
  const { getByText } = await render(
    <MealRow name="Egg" slot="100g" kcal={143} badge={<AppText>Pending</AppText>} />,
  );
  getByText("Pending");
  getByText("143 kcal");
});

// A queued log whose food fell out of the offline cache has no kcal to show.
// Rendering "0 kcal" would be a wrong number rather than an absent one, and a
// user reading their diary cannot tell the difference.
test("an unknown kcal renders a dash, not zero", async () => {
  const { getByText, queryByText } = await render(<MealRow name="Egg" slot="100g" kcal={null} />);
  getByText("— kcal");
  expect(queryByText("0 kcal")).toBeNull();
});
