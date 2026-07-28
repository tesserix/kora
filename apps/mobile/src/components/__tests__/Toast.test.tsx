import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text, Pressable } from "react-native";
import { ToastProvider, useToast } from "../Toast";

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return <Pressable onPress={() => toast.show({ message: "Logged", actionLabel: "Undo", onAction: onUndo })}><Text>go</Text></Pressable>;
}

function DurationTrigger({ durationMs }: { durationMs: number }) {
  const toast = useToast();
  return <Pressable onPress={() => toast.show({ message: "Logged", durationMs })}><Text>go</Text></Pressable>;
}

function NoActionTrigger() {
  const toast = useToast();
  return <Pressable onPress={() => toast.show({ message: "Logged" })}><Text>go</Text></Pressable>;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test("shows a message and fires the action", async () => {
  const onUndo = jest.fn();
  const { getByText } = await render(
    <ToastProvider><Trigger onUndo={onUndo} /></ToastProvider>,
  );
  // fireEvent is wrapped in an async act() so any React 19 scheduler work
  // queued under fake timers is flushed before the assertions run — plain
  // fireEvent.press() here leaves updates pending and trips React's
  // "overlapping act() calls" warning once waitFor's own fake-timer polling
  // loop kicks in.
  await act(async () => {
    fireEvent.press(getByText("go"));
  });
  await waitFor(() => getByText("Logged"));
  await act(async () => {
    fireEvent.press(getByText("Undo"));
  });
  expect(onUndo).toHaveBeenCalledTimes(1);
});

test("clears the auto-dismiss timer on unmount (no setState after unmount)", async () => {
  const { getByText, unmount } = await render(
    <ToastProvider><Trigger onUndo={() => {}} /></ToastProvider>,
  );
  await act(async () => {
    fireEvent.press(getByText("go"));
  });
  await waitFor(() => getByText("Logged"));
  // RNTL's unmount() is itself async (it wraps renderer.unmount() in its own
  // act() call), so it must be awaited before advancing timers — otherwise
  // its internal act() is still pending when ours starts, which trips
  // React's "overlapping act() calls" warning unrelated to the fix under
  // test. If the timer weren't cleared on unmount, the pending setState on
  // the unmounted tree would surface as a console.error below.
  await unmount();
  await act(async () => {
    jest.advanceTimersByTime(6000);
  });
});

test("auto-dismisses at a custom durationMs instead of the 5000ms default", async () => {
  const { getByText, queryByText } = await render(
    <ToastProvider><DurationTrigger durationMs={2000} /></ToastProvider>,
  );
  await act(async () => {
    fireEvent.press(getByText("go"));
  });
  await waitFor(() => getByText("Logged"));
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(queryByText("Logged")).toBeNull();
});

test("renders the message with no action button when actionLabel is omitted", async () => {
  const { getByText, queryByText } = await render(
    <ToastProvider><NoActionTrigger /></ToastProvider>,
  );
  await act(async () => {
    fireEvent.press(getByText("go"));
  });
  await waitFor(() => getByText("Logged"));
  expect(queryByText("Undo")).toBeNull();
});
