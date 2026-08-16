import { render, fireEvent, act } from "@testing-library/react-native";
import { Alert } from "react-native";
import { CopyDaySheet } from "../CopyDaySheet";

const mockCopyMutate = jest.fn();
const mockShow = jest.fn();
let mockCopyPending = false;
jest.mock("@/api/hooks", () => ({ useCopyDay: () => ({ mutate: mockCopyMutate, isPending: mockCopyPending }) }));
jest.mock("@/components/Toast", () => ({ useToast: () => ({ show: mockShow }) }));

let alert: jest.SpyInstance;
beforeEach(() => {
  mockCopyMutate.mockClear();
  mockShow.mockClear();
  mockCopyPending = false;
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

const iso = (d: Date) => d.toLocaleDateString("en-CA");

// #174: a copy writes a whole day's entries at once, so the confirm is pressed
// for the user in every test that expects the write to actually run.
async function confirmCopy() {
  const buttons = alert.mock.calls.at(-1)?.[2] as { text: string; onPress?: () => void }[];
  // The confirm's onPress runs the mutation, whose callbacks set state — so it
  // needs the same act() wrapper fireEvent would have given it.
  await act(async () => {
    buttons.find((b) => b.text === "Copy")!.onPress!();
  });
}

test("excludes the target day from the source chips", async () => {
  const target = iso(new Date());
  const { queryByLabelText } = await render(
    <CopyDaySheet visible targetDate={target} onClose={jest.fn()} />,
  );
  expect(queryByLabelText(`Copy from ${target}`)).toBeNull();
});

test("picking a day confirms before writing, and cancelling writes nothing", async () => {
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);

  expect(mockCopyMutate).not.toHaveBeenCalled();
  const [title, message, buttons] = alert.mock.calls.at(-1)!;
  expect(title).toMatch(/^Copy .+ into 2000-01-01\?$/);
  expect(message).toBe("Every entry logged that day is added to your diary. Undoing it means deleting each entry.");

  (buttons as { style?: string; onPress?: () => void }[]).find((b) => b.style === "cancel")?.onPress?.();
  expect(mockCopyMutate).not.toHaveBeenCalled();
});

test("confirming copies from the picked day into the target, reports the count, and closes", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 3 }));
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  await confirmCopy();

  expect(mockCopyMutate).toHaveBeenCalledWith(
    { from: expect.any(String), to: "2000-01-01" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(mockShow).toHaveBeenCalledWith({ message: "Copied 3 entries to 2000-01-01." });
  expect(onClose).toHaveBeenCalled();
});

test("a single copied entry is reported in the singular", async () => {
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 1 }));
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  await confirmCopy();
  expect(mockShow).toHaveBeenCalledWith({ message: "Copied 1 entry to 2000-01-01." });
});

test("copied:0 keeps the sheet open with an inline message and no completion toast", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 0 }));
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  await confirmCopy();
  expect(await findByText("That day had nothing to copy.")).toBeTruthy();
  expect(mockShow).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("copy error shows an inline message", async () => {
  mockCopyMutate.mockImplementation((_input, opts) => opts.onError?.());
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  await confirmCopy();
  expect(await findByText("Couldn't copy. Try again.")).toBeTruthy();
});

test("chips are disabled while a copy is pending", async () => {
  mockCopyPending = true;
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(alert).not.toHaveBeenCalled();
  expect(mockCopyMutate).not.toHaveBeenCalled();
});
