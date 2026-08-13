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

// The same engraved marker DetectedCard and the recipe screen use for a
// system-guessed portion (#138) — one signal, not three. Both directions
// matter: a marker that always renders is as wrong as one that never does.
test("an assumed-portion row shows the guess marker", async () => {
  const { getByText } = await render(
    <MealRow name="Egg" slot="100g" kcal={143} portionAssumed />,
  );
  getByText(/portion is a guess/i);
});

test("a plain row shows no guess marker", async () => {
  const { queryByText } = await render(<MealRow name="Egg" slot="100g" kcal={143} />);
  expect(queryByText(/portion is a guess/i)).toBeNull();
});

// portionAssumed omitted and portionAssumed={false} collapse to the same
// branch today — this pins that explicitly rather than only via the omitted
// case above, so a future change that treats them differently is caught.
test("an explicit portionAssumed={false} row shows no guess marker", async () => {
  const { queryByText } = await render(
    <MealRow name="Egg" slot="100g" kcal={143} portionAssumed={false} />,
  );
  expect(queryByText(/portion is a guess/i)).toBeNull();
});
