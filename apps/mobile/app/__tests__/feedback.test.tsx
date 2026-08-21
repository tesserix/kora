import { act, fireEvent, render } from "@testing-library/react-native";

import FeedbackScreen from "../feedback";

const mockBack = jest.fn();
jest.mock("expo-router", () => ({ router: { back: (...a: unknown[]) => mockBack(...a) } }));

const mockSubmitMutate = jest.fn();
let mockSubmitIsPending = false;
jest.mock("@/api/hooks", () => ({
  useSubmitFeedback: () => ({
    mutate: mockSubmitMutate,
    get isPending() {
      return mockSubmitIsPending;
    },
  }),
}));

jest.mock("@/lib/deviceContext", () => ({
  deviceContext: () => ({
    app_version: "1.2.3",
    platform: "ios",
    os_version: "18.0",
    device_model: "iPhone 15",
  }),
}));

beforeEach(() => {
  mockBack.mockClear();
  mockSubmitMutate.mockClear();
  mockSubmitIsPending = false;
});

test('renders both kind options and defaults to "bug"', async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  const bugTab = getByLabelText("Bug");
  const featureTab = getByLabelText("Idea");
  expect(bugTab.props.accessibilityState).toEqual({ selected: true });
  expect(featureTab.props.accessibilityState).toEqual({ selected: false });
});

test("submit is disabled until subject and description are both non-empty", async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  const sendButton = getByLabelText("Send");
  expect(sendButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

  await fireEvent.changeText(getByLabelText("Subject"), "Streak reset unexpectedly");
  expect(getByLabelText("Send").props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

  await fireEvent.changeText(getByLabelText("Description"), "It happened after I logged a meal at midnight.");
  expect(getByLabelText("Send").props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
});

test("whitespace-only subject keeps submit disabled", async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  await fireEvent.changeText(getByLabelText("Subject"), "   ");
  await fireEvent.changeText(getByLabelText("Description"), "Real description text here.");
  expect(getByLabelText("Send").props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

  await fireEvent.press(getByLabelText("Send"));
  expect(mockSubmitMutate).not.toHaveBeenCalled();
});

test("submits kind, subject, description and the device context", async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  await fireEvent.press(getByLabelText("Idea"));
  await fireEvent.changeText(getByLabelText("Subject"), "Dark mode for charts");
  await fireEvent.changeText(getByLabelText("Description"), "The weekly chart is hard to read at night.");
  await fireEvent.press(getByLabelText("Send"));

  expect(mockSubmitMutate).toHaveBeenCalledWith(
    {
      kind: "feature",
      subject: "Dark mode for charts",
      description: "The weekly chart is hard to read at night.",
      app_version: "1.2.3",
      platform: "ios",
      os_version: "18.0",
      device_model: "iPhone 15",
    },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

test("shows a success state after a successful submit", async () => {
  const { getByLabelText, findByText, queryByLabelText } = await render(<FeedbackScreen />);
  await fireEvent.changeText(getByLabelText("Subject"), "Streak reset unexpectedly");
  await fireEvent.changeText(getByLabelText("Description"), "It happened after I logged a meal at midnight.");
  await fireEvent.press(getByLabelText("Send"));

  const [, options] = mockSubmitMutate.mock.calls[0];
  await act(async () => options.onSuccess({ id: "fb_1", status: "received" }));

  expect(await findByText(/thanks/i)).toBeTruthy();
  expect(queryByLabelText("Send")).toBeNull();

  const doneButton = getByLabelText("Done");
  await fireEvent.press(doneButton);
  expect(mockBack).toHaveBeenCalled();
});

test("shows an inline error and keeps the entered text after a failed submit", async () => {
  const { getByLabelText, findByText } = await render(<FeedbackScreen />);
  const longDescription =
    "Paragraph one describing exactly what happened in detail. ".repeat(3) +
    "Paragraph two describing what I expected instead. ".repeat(3) +
    "Paragraph three with extra context that took time to write.";

  await fireEvent.changeText(getByLabelText("Subject"), "Crash on save");
  await fireEvent.changeText(getByLabelText("Description"), longDescription);
  await fireEvent.press(getByLabelText("Send"));

  const [, options] = mockSubmitMutate.mock.calls[0];
  await act(async () => options.onError(new Error("Network request failed")));

  expect(await findByText(/network request failed/i)).toBeTruthy();

  // The failure case that matters most: the user's text must survive the error.
  expect(getByLabelText("Subject").props.value).toBe("Crash on save");
  expect(getByLabelText("Description").props.value).toBe(longDescription);

  // The button must be re-enabled so the user can retry.
  expect(getByLabelText("Send").props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
});

test("enforces the subject and description length caps", async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  expect(getByLabelText("Subject").props.maxLength).toBe(200);
  expect(getByLabelText("Description").props.maxLength).toBe(4000);
});

// kora#294: these labels have a width budget, and the budget is the reason the
// copy is what it is. A segmented control splits one track into N equal parts,
// so each label gets a half-track — measured at 196.7pt at
// accessibility-extra-large on a 440pt screen. "Something's broken" wanted
// 344.8pt there and could only fit shrunk to 52% of the requested size.
//
// From that measurement: 344.8pt across 18 characters is ~19.2pt per character,
// so a half-track holds roughly 10. The cap below is that, not a taste.
//
// Character count is a PROXY for width, not width — Jest performs no layout and
// cannot measure a glyph (#257). A wide-glyph label inside the cap could still
// overflow. What this does catch is the regression that actually happened:
// someone writing a sentence where a word belongs.
const MAX_SEGMENT_CHARS = 10;

test("the kind labels stay inside a segment's half-track budget", async () => {
  const { getByLabelText } = await render(<FeedbackScreen />);
  for (const label of ["Bug", "Idea"]) {
    expect(getByLabelText(label)).toBeTruthy();
    expect(label.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
  }
});
