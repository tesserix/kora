import { act, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

import ResetPassword from "../reset-password";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: () => ({ email: "ann@example.com" }),
}));

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
});

test("sends a code, then sets the new password and signs in with it", async () => {
  const ui = await render(<ResetPassword />);
  expect(ui.getByLabelText("Email").props.value).toBe("ann@example.com");
  await fireEvent.press(ui.getByTestId("reset-submit"));
  expect(sessionMock.account.requestPasswordReset).toHaveBeenCalledWith("ann@example.com");
  // Worded as "if": kora-api answers the same for an address with no account.
  expect(ui.getByText(/If ann@example.com has a Kora account/)).toBeTruthy();

  await fireEvent.changeText(ui.getByLabelText("Code"), "xyz789");
  await fireEvent.changeText(ui.getByLabelText("New password"), "N3w!Password!");
  await fireEvent.press(ui.getByTestId("reset-submit"));
  expect(sessionMock.account.confirmPasswordReset).toHaveBeenCalledWith("ann@example.com", "XYZ789", "N3w!Password!");
  expect(sessionMock.signInWithPassword).toHaveBeenCalledWith("ann@example.com", "N3w!Password!");
  expect(router.replace).toHaveBeenCalledWith("/");
});

test("a weak new password is caught before the API", async () => {
  const ui = await render(<ResetPassword />);
  await fireEvent.press(ui.getByTestId("reset-submit"));
  await fireEvent.changeText(ui.getByLabelText("Code"), "XYZ789");
  await fireEvent.changeText(ui.getByLabelText("New password"), "weak");
  await fireEvent.press(ui.getByTestId("reset-submit"));
  expect(sessionMock.account.confirmPasswordReset).not.toHaveBeenCalled();
});
