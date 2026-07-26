import { render, fireEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import * as Haptics from "expo-haptics";
import { PressableScale, AnimatedNumber, haptics } from "@/motion";

afterEach(() => {
  jest.clearAllMocks();
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
