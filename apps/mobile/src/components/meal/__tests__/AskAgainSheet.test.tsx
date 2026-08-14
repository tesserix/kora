import { act, fireEvent, render } from "@testing-library/react-native";
import {
  AbortController as RNAbortController,
  AbortSignal as RNAbortSignal,
} from "abort-controller/dist/abort-controller";

import { AskAgainSheet } from "../AskAgainSheet";

const mockResolveMutate = jest.fn();
let mockIsPending = false;

jest.mock("@/api/hooks", () => ({
  useResolveText: () => ({ mutate: mockResolveMutate, isPending: mockIsPending }),
}));

beforeEach(() => {
  mockResolveMutate.mockReset();
  mockIsPending = false;
});

const PROPS = {
  visible: true,
  phrase: "two eggs",
  onSelect: jest.fn(),
  onManualSearch: jest.fn(),
  onClose: jest.fn(),
};

// #158: the sheet is dismissible three ways while a resolve is pending
// (backdrop tap, swipe-down, Android back), all of which funnel through
// Sheet's onClose. Before this, dismissing abandoned an AI call that kept
// running to completion or the 25s REQUEST_TIMEOUT_MS — billable work against
// a real user's per-user cap (#81).
test("submit passes an AbortSignal", async () => {
  const { getByText } = await render(<AskAgainSheet {...PROPS} />);
  await fireEvent.press(getByText("Ask Kora"));

  expect(mockResolveMutate).toHaveBeenCalledTimes(1);
  const [vars] = mockResolveMutate.mock.calls[0];
  expect(vars.input).toBe("two eggs");
  expect(vars.signal).toBeDefined();
  expect(vars.signal.aborted).toBe(false);
});

test("dismissing mid-resolve aborts the request", async () => {
  const onClose = jest.fn();
  const { getByText, getByLabelText } = await render(
    <AskAgainSheet {...PROPS} onClose={onClose} />,
  );
  await fireEvent.press(getByText("Ask Kora"));
  const [vars] = mockResolveMutate.mock.calls[0];
  expect(vars.signal.aborted).toBe(false);

  // Backdrop tap. Swipe-down and Android back both reach the same onClose.
  await fireEvent.press(getByLabelText("Close"));

  expect(vars.signal.aborted).toBe(true);
  expect(onClose).toHaveBeenCalled();
});

// These two MUST be able to fail: the callbacks have to run inside act() or
// React never flushes and the assertion passes whether or not the guard exists.
// Verified by removing the `signal.aborted` guards and watching both go red.
test("a late success after dismissal writes no state", async () => {
  const { getByText, getByLabelText, queryByText } = await render(<AskAgainSheet {...PROPS} />);
  await fireEvent.press(getByText("Ask Kora"));
  const [, opts] = mockResolveMutate.mock.calls[0];
  await fireEvent.press(getByLabelText("Close"));

  // The response lands after the user has gone. Applying it would resurrect a
  // result into a sheet they already dismissed.
  await act(async () => {
    opts.onSuccess({ tier: "follow_up", follow_up_question: "How many eggs?", candidates: [] });
  });
  expect(queryByText("How many eggs?")).toBeNull();
});

test("a late error after dismissal writes no state", async () => {
  const { getByText, getByLabelText, queryByText } = await render(<AskAgainSheet {...PROPS} />);
  await fireEvent.press(getByText("Ask Kora"));
  const [, opts] = mockResolveMutate.mock.calls[0];
  await fireEvent.press(getByLabelText("Close"));

  await act(async () => {
    opts.onError(new Error("boom"));
  });
  expect(queryByText("Couldn't ask Kora right now. Try again.")).toBeNull();
});

// The device does NOT have Node's AbortController. React Native polyfills the
// globals with abort-controller 3.0.0, whose signal has no `reason` and whose
// abort() takes no argument. Every test above runs on Node's native one, so a
// fix that leaned on `reason` would be fully green and fully dead on a phone.
// Same guard as src/lib/__tests__/api.test.ts.
describe("against React Native's AbortController polyfill", () => {
  const nativeAbortController = global.AbortController;
  const nativeAbortSignal = global.AbortSignal;

  beforeAll(() => {
    global.AbortController = RNAbortController as unknown as typeof AbortController;
    global.AbortSignal = RNAbortSignal as unknown as typeof AbortSignal;
  });
  afterAll(() => {
    global.AbortController = nativeAbortController;
    global.AbortSignal = nativeAbortSignal;
  });

  test("dismissing still aborts, using only `aborted`", async () => {
    const { getByText, getByLabelText } = await render(<AskAgainSheet {...PROPS} />);
    await fireEvent.press(getByText("Ask Kora"));
    const [vars] = mockResolveMutate.mock.calls[0];

    expect("reason" in vars.signal).toBe(false); // the property the device lacks
    await fireEvent.press(getByLabelText("Close"));
    expect(vars.signal.aborted).toBe(true);
  });
});
