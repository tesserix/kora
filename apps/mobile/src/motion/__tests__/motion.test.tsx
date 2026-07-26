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
