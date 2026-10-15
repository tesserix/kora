import { fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

import TwoStep from "../two-step";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
});

async function enter(ui: Awaited<ReturnType<typeof render>>, code: string) {
  await fireEvent.changeText(ui.getByLabelText("Code"), code);
  await fireEvent.press(ui.getByTestId("two-step-submit"));
}

test("a correct code finishes the sign-in", async () => {
  const ui = await render(<TwoStep />);
  await enter(ui, "123 456");
  expect(sessionMock.completeTOTP).toHaveBeenCalledWith("123456");
  expect(router.replace).toHaveBeenCalledWith("/");
});

test("anything but six digits is caught before the API", async () => {
  const ui = await render(<TwoStep />);
  await enter(ui, "12345");
  expect(sessionMock.completeTOTP).not.toHaveBeenCalled();
  expect(ui.getByText("The code is 6 digits. Check your authenticator app.")).toBeTruthy();
});

test("a wrong code says so and can be retried", async () => {
  sessionMock.completeTOTP.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("invalid_code", "That code didn't work. Check your authenticator app and try again."),
  );
  const ui = await render(<TwoStep />);
  await enter(ui, "000000");
  expect(await ui.findByText(/That code didn't work/)).toBeTruthy();
  expect(ui.getByTestId("two-step-submit")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});

test("an expired sign-in offers to start again", async () => {
  sessionMock.completeTOTP.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("challenge_expired", "That sign-in has expired. Please sign in again."),
  );
  const ui = await render(<TwoStep />);
  await enter(ui, "123456");
  expect(await ui.findByText("That sign-in has expired. Please sign in again.")).toBeTruthy();
  await fireEvent.press(ui.getByTestId("two-step-restart"));
  expect(router.replace).toHaveBeenCalledWith("/sign-in");
});
