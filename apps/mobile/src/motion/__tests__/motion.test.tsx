import { render, fireEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import * as Haptics from "expo-haptics";
import * as Reanimated from "react-native-reanimated";
import { PressableScale, AnimatedNumber, haptics } from "@/motion";

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks resets call history but not a mockReturnValue override, so
  // restore the default (reduceMotion off) explicitly after every test.
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

test("PressableScale fires onPress and the mapped haptic", async () => {
  const onPress = jest.fn();
  const { findByText } = await render(
    <PressableScale haptic="selection" onPress={onPress}>
      <Text>Press me</Text>
    </PressableScale>,
  );
  fireEvent.press(await findByText("Press me"));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
});

test("PressableScale with haptic none calls no haptics", async () => {
  const onPress = jest.fn();
  const { findByText } = await render(
    <PressableScale haptic="none" onPress={onPress}>
      <Text>No haptic</Text>
    </PressableScale>,
  );
  fireEvent.press(await findByText("No haptic"));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
});

// NOTE: the jest reanimated mock NOOPs useAnimatedReaction, so these tests
// exercise the initial render / reduced-motion snap paths only. They cannot
// catch worklet-runtime bugs in the reaction body (e.g. calling a JS-thread
// `format` function inside the reaction, which crashes on-device with
// "[Worklets] Tried to synchronously call a Remote Function" on reanimated
// 4.5 + worklets). That class of bug is device-only-verifiable; the fix is
// to keep `format` out of the reaction and only apply it at render time on
// the JS thread.
test("AnimatedNumber renders the formatted target value", async () => {
  const { findByText } = await render(<AnimatedNumber value={1234} />);
  expect(await findByText("1,234")).toBeTruthy();
});

test("haptics.success swallows a rejected promise", async () => {
  (Haptics.notificationAsync as jest.Mock).mockRejectedValueOnce(new Error("no haptics hardware"));
  expect(() => haptics.success()).not.toThrow();
  await Promise.resolve();
  await Promise.resolve();
});

test("AnimatedNumber snaps to the new value immediately when reduceMotion is true", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const { findByText, rerender } = await render(<AnimatedNumber value={100} />);
  expect(await findByText("100")).toBeTruthy();

  await rerender(<AnimatedNumber value={250} />);
  expect(await findByText("250")).toBeTruthy();
});

// The press-scale is observed through withSpring rather than the rendered
// transform: the reanimated mock mutates a shared value that does not trigger
// a re-render, so reading the transform back cannot distinguish "did not
// animate" from "has not re-rendered" — it reports scale 1 either way.

// A PressableScale with no handler at all is decoration. Springing under the
// finger is the same false affordance as announcing it a button or buzzing:
// the touch says "this does something" and nothing happens. MealRow renders
// exactly this way for a pending queued row.
test("PressableScale does not start the press-scale when it has no handler", async () => {
  const spy = jest.spyOn(Reanimated, "withSpring");
  const { getByTestId } = await render(
    <PressableScale testID="inert-row">
      <Text>Inert</Text>
    </PressableScale>,
  );
  spy.mockClear();

  fireEvent(getByTestId("inert-row"), "pressIn");

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("PressableScale starts the press-scale when it has an onPress", async () => {
  const spy = jest.spyOn(Reanimated, "withSpring");
  const { getByTestId } = await render(
    <PressableScale testID="live-row" onPress={jest.fn()}>
      <Text>Live</Text>
    </PressableScale>,
  );
  spy.mockClear();

  fireEvent(getByTestId("live-row"), "pressIn");

  expect(spy).toHaveBeenCalledWith(0.96, expect.anything());
  spy.mockRestore();
});

// app/friends.tsx has a row whose only interaction is a long press. Gating
// purely on onPress would wrongly silence a genuinely interactive control.
test("PressableScale starts the press-scale for a long-press-only row", async () => {
  const spy = jest.spyOn(Reanimated, "withSpring");
  const { getByTestId } = await render(
    <PressableScale testID="hold-row" onLongPress={jest.fn()}>
      <Text>Hold me</Text>
    </PressableScale>,
  );
  spy.mockClear();

  fireEvent(getByTestId("hold-row"), "pressIn");

  expect(spy).toHaveBeenCalledWith(0.96, expect.anything());
  spy.mockRestore();
});

test("PressableScale still fires its haptic under reduced motion", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const onPress = jest.fn();
  const { findByText } = await render(
    <PressableScale haptic="selection" onPress={onPress}>
      <Text>Press me (reduced motion)</Text>
    </PressableScale>,
  );
  fireEvent.press(await findByText("Press me (reduced motion)"));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
});
