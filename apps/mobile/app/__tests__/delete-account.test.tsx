import { act, render, fireEvent, waitFor } from "@testing-library/react-native";

import DeleteAccount from "../delete-account";

const mockReplace = jest.fn();
const mockBack = jest.fn();
jest.mock("expo-router", () => ({
  router: {
    replace: (...a: unknown[]) => mockReplace(...a),
    back: (...a: unknown[]) => mockBack(...a),
  },
}));

const mockDeleteAccount = jest.fn();
jest.mock("@/api/hooks", () => ({ deleteAccount: () => mockDeleteAccount() }));

const mockUnregister = jest.fn();
const mockRegister = jest.fn();
jest.mock("@/lib/push", () => ({
  unregisterPushToken: () => mockUnregister(),
  registerPushToken: () => mockRegister(),
}));

const mockSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ signOut: (...a: unknown[]) => mockSignOut(...a) }));
jest.mock("@/lib/firebase", () => ({ auth: { name: "fake-auth" } }));

beforeEach(() => {
  mockReplace.mockClear();
  mockBack.mockClear();
  mockSignOut.mockReset().mockResolvedValue(undefined);
  mockDeleteAccount.mockReset().mockResolvedValue(undefined);
  mockUnregister.mockReset().mockResolvedValue(undefined);
  mockRegister.mockReset().mockResolvedValue(undefined);
});

test("names what is destroyed and that it is irreversible", async () => {
  const { getByText } = await render(<DeleteAccount />);
  expect(getByText(/cannot be undone/i)).toBeTruthy();
  expect(getByText(/saved meals/i)).toBeTruthy();
  expect(getByText(/coach conversations/i)).toBeTruthy();
});

test("the confirm button does nothing until the word is typed", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.press(getByTestId("confirm-delete"));
  expect(mockDeleteAccount).not.toHaveBeenCalled();

  await fireEvent.changeText(getByTestId("confirm-input"), "delet");
  await fireEvent.press(getByTestId("confirm-delete"));
  expect(mockDeleteAccount).not.toHaveBeenCalled();
});

test("a capitalised or padded 'Delete' is accepted", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "  Delete ");
  await fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));
});

test("success de-registers push, deletes, signs out, then replaces to sign-in", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockUnregister).toHaveBeenCalledTimes(1);
  expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalledTimes(1);

  // Order matters: de-registration needs a live session, and sign-out must not
  // happen before the account is actually gone.
  const unregisterOrder = mockUnregister.mock.invocationCallOrder[0];
  const deleteOrder = mockDeleteAccount.mock.invocationCallOrder[0];
  const signOutOrder = mockSignOut.mock.invocationCallOrder[0];
  expect(unregisterOrder).toBeLessThan(deleteOrder);
  expect(deleteOrder).toBeLessThan(signOutOrder);
});

test("a failed push de-registration does not block deletion", async () => {
  mockUnregister.mockRejectedValue(new Error("no token"));
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
});

test("a failed deletion shows mapped copy, stays put, and does not sign out", async () => {
  const apiError = Object.assign(new Error("boom"), { name: "ApiError", status: 500 });
  mockDeleteAccount.mockRejectedValue(apiError);

  const { getByTestId, getByText } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() =>
    expect(getByText("Kora is having trouble right now. Please try again in a moment.")).toBeTruthy(),
  );
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockReplace).not.toHaveBeenCalled();
});

// De-registration runs first and unconditionally, because unregisterDevice
// needs a live session. If the delete then fails the user keeps their account
// but has been silently de-registered, and nothing else would ever put it
// back — registerPushToken's other caller needs an auth transition that never
// comes, because this user never signed out.
test("a failed deletion re-registers push for the account that survived", async () => {
  mockDeleteAccount.mockRejectedValue(new Error("transient"));

  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
  expect(mockUnregister).toHaveBeenCalledTimes(1);
  expect(mockReplace).not.toHaveBeenCalled();
});

// The dominant cause of a failed deleteAccount() is a bad network, and
// registerPushToken() goes over that same bad network — so awaiting it before
// surfacing the error would leave the user staring at "Deleting…" for up to
// REQUEST_TIMEOUT_MS with no feedback. The error must appear even while
// re-registration is still in flight.
test("a failed deletion surfaces the error without waiting for re-registration", async () => {
  const apiError = Object.assign(new Error("boom"), { name: "ApiError", status: 500 });
  mockDeleteAccount.mockRejectedValue(apiError);
  mockRegister.mockReturnValue(new Promise(() => {}));

  const { getByTestId, getByText } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() =>
    expect(getByText("Kora is having trouble right now. Please try again in a moment.")).toBeTruthy(),
  );
  expect(getByTestId("confirm-delete").props.accessibilityState.disabled).toBe(false);
});

test("a successful deletion does not re-register push", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockRegister).not.toHaveBeenCalled();
});

// The guard is a ref, not the `pending` state: both presses here are dispatched
// before React commits setPending(true), so a state read from the render
// closure would let both through and fire two deletes.
test("a double tap sends exactly one delete", async () => {
  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");

  // Both presses go inside ONE act(): `await fireEvent.press(...)` twice would
  // flush React's state queue in between, so the second press would see the
  // committed `pending` (and the now-genuinely-disabled button) and the race
  // the ref guards would never be reproduced. React logs an overlapping-act
  // notice for the nesting; the alternative — leaving the presses unawaited —
  // corrupts every later render in the file.
  const button = getByTestId("confirm-delete");
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
  expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
});

// Navigation is deliberately unconditional past the delete: the account is
// already gone server-side, and a failed sign-out must not strand the user on a
// screen for an account that no longer exists.
test("a failed sign-out still lands the user on sign-in", async () => {
  mockSignOut.mockRejectedValue(new Error("network"));

  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));

  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
});

test("the failed request can be retried without retyping", async () => {
  mockDeleteAccount.mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);

  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));

  await fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
});
