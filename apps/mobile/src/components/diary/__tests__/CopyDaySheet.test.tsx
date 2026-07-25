import { render, fireEvent } from "@testing-library/react-native";
import { CopyDaySheet } from "../CopyDaySheet";

const mockCopyMutate = jest.fn();
let mockCopyPending = false;
jest.mock("@/api/hooks", () => ({ useCopyDay: () => ({ mutate: mockCopyMutate, isPending: mockCopyPending }) }));
beforeEach(() => { mockCopyMutate.mockClear(); mockCopyPending = false; });

const iso = (d: Date) => d.toLocaleDateString("en-CA");

test("excludes the target day from the source chips", async () => {
  const target = iso(new Date());
  const { queryByLabelText } = await render(
    <CopyDaySheet visible targetDate={target} onClose={jest.fn()} />,
  );
  expect(queryByLabelText(`Copy from ${target}`)).toBeNull();
});

test("picking a day copies from it into the target and closes on copied>0", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 3 }));
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(mockCopyMutate).toHaveBeenCalledWith(
    { from: expect.any(String), to: "2000-01-01" },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
  expect(onClose).toHaveBeenCalled();
});

test("copied:0 keeps the sheet open with an inline message", async () => {
  const onClose = jest.fn();
  mockCopyMutate.mockImplementation((_input, opts) => opts.onSuccess?.({ copied: 0 }));
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={onClose} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(await findByText("That day had nothing to copy.")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test("copy error shows an inline message", async () => {
  mockCopyMutate.mockImplementation((_input, opts) => opts.onError?.());
  const { getAllByLabelText, findByText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(await findByText("Couldn't copy. Try again.")).toBeTruthy();
});

test("chips are disabled while a copy is pending", async () => {
  mockCopyPending = true;
  const { getAllByLabelText } = await render(
    <CopyDaySheet visible targetDate="2000-01-01" onClose={jest.fn()} />,
  );
  await fireEvent.press(getAllByLabelText(/^Copy from /)[0]);
  expect(mockCopyMutate).not.toHaveBeenCalled();
});
