import { render, fireEvent } from "@testing-library/react-native";
import { AppText } from "../Text";
import { Sheet } from "../Sheet";

// Reduced motion true -> dismiss() calls onClose() synchronously (no spring settle to await),
// per the brief's reduced-motion branch.
jest.mock("@/motion/useMotionPrefs", () => ({ useMotionPrefs: () => ({ reduceMotion: true }) }));

test("shows content when visible", async () => {
  const { findByText } = await render(
    <Sheet visible onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  expect(await findByText("Sheet body")).toBeTruthy();
});

test("hides content when not visible", async () => {
  const { queryByText } = await render(
    <Sheet visible={false} onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  expect(queryByText("Sheet body")).toBeNull();
});

test("pressing the scrim calls onClose", async () => {
  const onClose = jest.fn();
  const { getByLabelText } = await render(
    <Sheet visible onClose={onClose}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  await fireEvent.press(getByLabelText("Close"));
  expect(onClose).toHaveBeenCalled();
});

// kora#182. Every sheet is bottom-anchored, so a raised keyboard sat directly
// on top of its content. FoodPicker is the worst case — TextInput at the top,
// results list below — which made correcting a misidentified food impossible
// on a device: "the row was tappable but editing wasnt usable keyboard was
// covering the list".
//
// Fixed here rather than in FoodPicker because all eleven sheets with a text
// input share the defect. Asserted structurally because a keyboard cannot be
// raised under Jest — the check is that the mechanism is present and wraps the
// sheet, which is the part that regressed by being absent entirely.
test("the sheet body is wrapped in a keyboard-avoiding container", async () => {
  const { getByTestId } = await render(
    <Sheet visible onClose={() => {}}>
      <AppText>Sheet body</AppText>
    </Sheet>
  );
  // Presence is the assertion, and it is the right one: the defect was that
  // NO keyboard mechanism existed anywhere in this component. The `behavior`
  // prop is deliberately not asserted — getByTestId returns the host View that
  // KeyboardAvoidingView renders, which does not carry it, so an assertion
  // here would be testing the mock rather than the choice.
  expect(getByTestId("sheet-keyboard-avoider")).toBeTruthy();
});
