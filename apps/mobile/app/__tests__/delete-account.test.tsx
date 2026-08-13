import { render, fireEvent, waitFor } from "@testing-library/react-native";

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
jest.mock("@/lib/push", () => ({ unregisterPushToken: () => mockUnregister() }));

const mockSignOut = jest.fn();
jest.mock("firebase/auth", () => ({ signOut: (...a: unknown[]) => mockSignOut(...a) }));
jest.mock("@/lib/firebase", () => ({ auth: { name: "fake-auth" } }));

import DeleteAccount from "../delete-account";

beforeEach(() => {
  mockReplace.mockClear();
  mockBack.mockClear();
  mockSignOut.mockClear();
  mockDeleteAccount.mockReset().mockResolvedValue(undefined);
  mockUnregister.mockReset().mockResolvedValue(undefined);
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

test("the failed request can be retried without retyping", async () => {
  mockDeleteAccount.mockRejectedValueOnce(new Error("transient")).mockResolvedValue(undefined);

  const { getByTestId } = await render(<DeleteAccount />);
  await fireEvent.changeText(getByTestId("confirm-input"), "delete");
  await fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockDeleteAccount).toHaveBeenCalledTimes(1));

  await fireEvent.press(getByTestId("confirm-delete"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
});
