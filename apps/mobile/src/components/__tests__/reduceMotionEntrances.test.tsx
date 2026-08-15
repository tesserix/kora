import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import * as Reanimated from "react-native-reanimated";
import { OttoBubble } from "@/components/capture/OttoBubble";
import { UserBubble } from "@/components/capture/UserBubble";
import { ToastProvider, useToast } from "@/components/Toast";

// kora#175 §4. Reanimated 4.5 degrades every animation under Reduce Motion to
// an INSTANT JUMP, not a cross-fade — so a bare FadeInDown becomes a pop-in,
// and the *opacity* half of the entrance, which is exactly the fallback the
// preference asks for, gets thrown away along with the translate. The fix is
// to substitute the gentler animation rather than to keep the guard.
//
// This pins the two entrance shapes the app uses. The four screens
// (app/(tabs)/index.tsx, diary.tsx, progress.tsx, app/log.tsx) share one
// identical `enter(i)` helper, which is changed the same way.

afterEach(() => {
  jest.clearAllMocks();
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(false);
});

function Trigger() {
  const toast = useToast();
  return (
    <Pressable onPress={() => toast.show({ message: "Logged" })}>
      <Text>go</Text>
    </Pressable>
  );
}

test("a chat bubble drops in normally", async () => {
  const view = await render(<OttoBubble>Hi</OttoBubble>);
  expect(view.root!.props.entering).toBe(Reanimated.FadeInDown);
});

test("a chat bubble cross-fades instead of popping in under reduce motion", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const view = await render(<OttoBubble>Hi</OttoBubble>);
  expect(view.root!.props.entering).toBe(Reanimated.FadeIn);
});

test("the user's own bubble cross-fades under reduce motion too", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const view = await render(<UserBubble>I ate an egg</UserBubble>);
  expect(view.root!.props.entering).toBe(Reanimated.FadeIn);
});

test("the toast cross-fades under reduce motion", async () => {
  (Reanimated.useReducedMotion as jest.Mock).mockReturnValue(true);
  const { getByText, getByTestId } = await render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  await act(async () => {
    fireEvent.press(getByText("go"));
  });
  await waitFor(() => getByText("Logged"));

  expect(getByTestId("toast").props.entering).toBe(Reanimated.FadeIn);
});
