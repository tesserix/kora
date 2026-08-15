import { act, fireEvent, render } from "@testing-library/react-native";
import type { ReactElement } from "react";
import type { ViewStyle } from "react-native";
import { StyleSheet } from "react-native";
import TestRenderer from "react-test-renderer";
import * as Reanimated from "react-native-reanimated";
import { MealRow } from "@/components/MealRow";
import { Segmented } from "@/components/Segmented";
import { Stepper } from "@/components/Stepper";
import { VoiceComposer } from "@/components/capture/VoiceComposer";

// kora#175 §1: 37 of the app's 40 raw <Pressable>s rendered NOTHING on press.
// Pinning all 37 would be 37 near-identical tests, so this file pins a
// representative sample chosen for coverage of the distinct cases rather than
// for count:
//   - VoiceComposer's mic — the site with the 200ms PRESS_ARM_MS delay that
//     the missing feedback was covering. Uses the opacity idiom, NOT
//     PressableScale: it sits inside a GestureDetector, and that pairing
//     crashed on device (see the test below and gestureDetectorChild.test.ts).
//   - MealRow's pin glyph — the opacity idiom, chosen where a scale would
//     visibly disturb a dense row.
//   - Segmented's segment — the opacity idiom on a control whose own sliding
//     pill a scale would fight.
//   - Stepper's − / + — the opacity idiom on a press-AND-HOLD control, where
//     the feedback has to persist for the whole hold rather than blink.
// app/capture.tsx's viewfinder (the app's central action) is pinned in
// app/__tests__/capture.test.tsx, next to the rest of that screen's coverage.

afterEach(() => {
  jest.clearAllMocks();
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

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

/**
 * The style a labelled Pressable renders in a given press state.
 *
 * The opacity idiom lives in the `style` FUNCTION a raw Pressable takes, and
 * RN resolves that function internally — the host element RNTL hands back only
 * ever carries the already-resolved result for the CURRENT state, and RNTL's
 * `fireEvent(el, "pressIn")` drives the `onPressIn` prop, which these controls
 * deliberately do not have. So neither RNTL query reaches the pressed style.
 * react-test-renderer is used here (and only here) because it still exposes
 * composite elements, and the style function is what actually has to be
 * pinned: pressed renders dimmer, released renders solid.
 */
function styleForPressState(ui: ReactElement, accessibilityLabel: string, pressed: boolean): ViewStyle {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  TestRenderer.act(() => {
    tree = TestRenderer.create(ui);
  });
  const matches = tree!.root.findAll(
    (node) =>
      node.props?.accessibilityLabel === accessibilityLabel && typeof node.props?.style === "function",
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one style-function Pressable labelled "${accessibilityLabel}", got ${matches.length}`);
  }
  return StyleSheet.flatten(matches[0].props.style({ pressed })) ?? {};
}

// The mic dims rather than springs, and that is not a stylistic preference.
// It lives inside a GestureDetector, which reaches its child's native view by
// cloning it with a ref — and PressableScale forwards no ref, so the pairing
// crashed on device in build 21 (kora#175 regression). The press-down feedback
// the arming delay needs is still here; it just comes from the `pressed` style
// callback, which needs no ref. See gestureDetectorChild.test.ts, which stops
// the crashing pairing coming back.
test("the mic dims on press-down, so the arming delay is not silent", () => {
  const mic = (
    <VoiceComposer isRecording={false} onStart={jest.fn()} onFinish={jest.fn()} onCancel={jest.fn()} />
  );

  expect(styleForPressState(mic, "Hold to record", false).opacity).toBe(1);
  expect(styleForPressState(mic, "Hold to record", true).opacity).toBeLessThan(1);
});

test("a meal row's pin glyph dims under the finger without moving the row", () => {
  const row = <MealRow name="Egg" slot="100g" kcal={143} onPinToggle={jest.fn()} />;

  expect(styleForPressState(row, "Pin Egg", false).opacity).toBe(1);
  expect(styleForPressState(row, "Pin Egg", true).opacity).toBeLessThan(1);
  // A dim is not a move: a scale transform here would visibly jitter the row.
  expect(styleForPressState(row, "Pin Egg", true).transform).toBeUndefined();
});

test("a segment dims under the finger", () => {
  const control = (
    <Segmented
      options={[
        { key: "week", label: "Week" },
        { key: "month", label: "Month" },
      ]}
      value="week"
      onChange={jest.fn()}
    />
  );

  expect(styleForPressState(control, "Month", false).opacity).toBe(1);
  expect(styleForPressState(control, "Month", true).opacity).toBeLessThan(1);
});

// The stepper repeats while held (400ms, then every 120ms), so its feedback
// has to hold for the whole press rather than flash on the release.
test("a stepper button stays dimmed for the length of the hold", () => {
  const stepper = <Stepper value={100} onChange={jest.fn()} />;

  expect(styleForPressState(stepper, "Decrease", false).opacity).toBe(1);
  expect(styleForPressState(stepper, "Decrease", true).opacity).toBeLessThan(1);
  expect(styleForPressState(stepper, "Increase", true).opacity).toBeLessThan(1);
});
