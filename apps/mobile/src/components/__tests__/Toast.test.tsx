import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { Text, Pressable } from "react-native";
import { ToastProvider, useToast } from "../Toast";

function Trigger({ onUndo }: { onUndo: () => void }) {
  const toast = useToast();
  return <Pressable onPress={() => toast.show({ message: "Logged", actionLabel: "Undo", onAction: onUndo })}><Text>go</Text></Pressable>;
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
