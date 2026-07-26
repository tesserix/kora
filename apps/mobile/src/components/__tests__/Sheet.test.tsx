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
