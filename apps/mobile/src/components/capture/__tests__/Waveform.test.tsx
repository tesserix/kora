import { Animated } from "react-native";
import { render } from "@testing-library/react-native";
import * as Reanimated from "react-native-reanimated";
import { Waveform } from "../Waveform";

afterEach(() => {
  jest.restoreAllMocks();
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

test("renders the 9 bars from the mockup", async () => {
  const { getAllByTestId } = await render(<Waveform active />);
  expect(getAllByTestId("waveform-bar")).toHaveLength(9);
});

test("renders bars without throwing when inactive", async () => {
  const { getAllByTestId } = await render(<Waveform active={false} />);
  expect(getAllByTestId("waveform-bar")).toHaveLength(9);
});

// kora#175 §5. The preference used to be read once, in a mount-only
// AccessibilityInfo query with no `reduceMotionChanged` listener, so turning
// Reduce Motion on mid-session left the bars looping until the next mount.
// useMotionPrefs wraps reanimated's useReducedMotion, which IS subscribed.
test("does not loop the bars when Reduce Motion is on", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const loop = jest.spyOn(Animated, "loop");

  await render(<Waveform active />);

  expect(loop).not.toHaveBeenCalled();
});

test("picks the preference up when it changes, without remounting", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const loop = jest.spyOn(Animated, "loop");
  const { rerender } = await render(<Waveform active />);
  expect(loop).not.toHaveBeenCalled();

  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
  await rerender(<Waveform active />);

  expect(loop).toHaveBeenCalled();
});
