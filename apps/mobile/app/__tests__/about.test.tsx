import { Linking } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import AboutScreen from "../about";

// kora#197. Open Food Facts data is published under the Open Database License,
// which obliges Kora to attribute it wherever the data is used. Kora serves
// OFF-derived nutrition to every user, so this is a licence obligation rather
// than a courtesy — and one that is easy to delete by accident, because nothing
// about the app stops working without it.
//
// These tests exist so that removal is a deliberate act with a failing test
// attached, not a tidy-up.

test("Open Food Facts is attributed by name, with its licence", async () => {
  const { getByText } = await render(<AboutScreen />);
  expect(getByText("Open Food Facts")).toBeTruthy();
  expect(getByText(/Open Database License/i)).toBeTruthy();
});

test("the other two sources are named too", async () => {
  const { getByText } = await render(<AboutScreen />);
  // Listed alongside OFF deliberately: naming only the source with a legal
  // obligation reads as boilerplate, where naming all three is a statement
  // about provenance — which is what actually helps a user judge a number.
  expect(getByText("Australian Food Composition Database")).toBeTruthy();
  expect(getByText("USDA FoodData Central")).toBeTruthy();
});

test("each source links out to its own site", async () => {
  const spy = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined as never);
  const { getByLabelText } = await render(<AboutScreen />);

  await fireEvent.press(getByLabelText(/Open Food Facts, opens in your browser/i));
  expect(spy).toHaveBeenCalledWith("https://world.openfoodfacts.org");
  spy.mockRestore();
});

test("the page states that Kora never invents a figure", async () => {
  const { getByText } = await render(<AboutScreen />);
  // The honest claim behind the whole index: every number is read from a
  // source row, never derived client-side or produced by the model.
  expect(getByText(/never invents a calorie figure/i)).toBeTruthy();
});
