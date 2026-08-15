import { act, render, fireEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import * as Haptics from "expo-haptics";
import * as Reanimated from "react-native-reanimated";
import { PressableScale } from "@/motion";

afterEach(() => {
  jest.clearAllMocks();
  // clearAllMocks resets call history but not a mockReturnValue override, so
  // restore the default (reduceMotion off) explicitly after every test.
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

// A press-down here is deliberately always matched by a press-out (or a full
// `press`). Leaving a Pressable held down at the end of a test carries the
// active-press state into RNTL's cleanup, which surfaces as "overlapping
// act() calls" and an empty tree in whichever test happens to run next.
async function pressDown(element: Parameters<typeof fireEvent>[0]): Promise<void> {
  await act(async () => {
    fireEvent(element, "pressIn");
  });
}

async function release(element: Parameters<typeof fireEvent>[0]): Promise<void> {
  await act(async () => {
    fireEvent(element, "pressOut");
  });
}

// kora#175 §2. An impact haptic is a physical-contact metaphor: it has to land
// on the frame the finger touches down, alongside the scale, not on the lift
// 150-400ms later. The camera cap in FloatingTabBar is the worst case — it
// thumped as you let go.
test("an impact haptic lands on press-down, not on the release", async () => {
  const { getByTestId } = await render(
    <PressableScale testID="cap" haptic="impactLight" onPress={jest.fn()}>
      <Text>Capture</Text>
    </PressableScale>,
  );

  await pressDown(getByTestId("cap"));
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);

  // …and the release must not double it up.
  await release(getByTestId("cap"));
  fireEvent.press(getByTestId("cap"));
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
});

// Commit-class feedback reports an outcome, so it belongs on the event that
// produces the outcome — the release — not the touch that precedes it.
test("a commit-class haptic stays on the release", async () => {
  const { getByTestId } = await render(
    <PressableScale testID="commit" haptic="success" onPress={jest.fn()}>
      <Text>Save</Text>
    </PressableScale>,
  );

  await pressDown(getByTestId("commit"));
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();

  await release(getByTestId("commit"));
  fireEvent.press(getByTestId("commit"));
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
});

// kora#175 §4. Reduce Motion is a vestibular preference, and a 100ms opacity
// dip has no vestibular component — so the preference must soften the press
// feedback, never delete it. Previously the guard removed it outright and
// Reduce Motion users got a completely dead button.
test("reduce motion softens the press feedback instead of removing it", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const spy = jest.spyOn(Reanimated, "withTiming");
  const { getByTestId } = await render(
    <PressableScale testID="soft" onPress={jest.fn()}>
      <Text>Soft</Text>
    </PressableScale>,
  );
  spy.mockClear();

  await pressDown(getByTestId("soft"));
  expect(spy).toHaveBeenCalledTimes(1);
  expect((spy.mock.calls[0] as [number, unknown])[0]).toBeLessThan(1);

  spy.mockClear();
  await release(getByTestId("soft"));
  expect(spy).toHaveBeenCalledWith(1, expect.anything());
  spy.mockRestore();
});

// The dip is still feedback for a real interaction, so an inert decorative
// PressableScale must not dip either — the same false-affordance rule the
// scale already follows.
test("reduce motion does not dip a PressableScale with no handler", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const spy = jest.spyOn(Reanimated, "withTiming");
  const { getByTestId } = await render(
    <PressableScale testID="inert">
      <Text>Inert</Text>
    </PressableScale>,
  );
  spy.mockClear();

  await pressDown(getByTestId("inert"));
  await release(getByTestId("inert"));

  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
