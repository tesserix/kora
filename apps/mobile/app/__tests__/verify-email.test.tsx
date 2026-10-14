import { act, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";

import VerifyEmail from "../verify-email";
import { holdCredentials, takeCredentials } from "@/auth/flow";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: () => ({ email: "ann@example.com" }),
}));

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
  takeCredentials("");
});

async function enter(ui: Awaited<ReturnType<typeof render>>, code: string) {
  await fireEvent.changeText(ui.getByLabelText("Code"), code);
  await fireEvent.press(ui.getByTestId("verify-submit"));
}

test("a correct code signs straight in with the held password", async () => {
  holdCredentials("ann@example.com", "pw");
  const ui = await render(<VerifyEmail />);
  await enter(ui, "abc123");
  expect(sessionMock.account.verifyEmail).toHaveBeenCalledWith("ann@example.com", "ABC123");
  expect(sessionMock.signInWithPassword).toHaveBeenCalledWith("ann@example.com", "pw");
  expect(router.replace).toHaveBeenCalledWith("/");
  // Handed out once.
  expect(takeCredentials("ann@example.com")).toBeNull();
});

test("with nothing held it sends the person to sign in, email prefilled", async () => {
  const ui = await render(<VerifyEmail />);
  await enter(ui, "ABC123");
  expect(sessionMock.signInWithPassword).not.toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith({ pathname: "/sign-in", params: { reason: "verified", email: "ann@example.com" } });
});

test("a wrong code says so and keeps the held password for the retry", async () => {
  holdCredentials("ann@example.com", "pw");
  sessionMock.account.verifyEmail.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("invalid_code", "That code is wrong or has expired."),
  );
  const ui = await render(<VerifyEmail />);
  await enter(ui, "WRONG1");
  expect(await ui.findByText("That code is wrong or has expired.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  expect(takeCredentials("ann@example.com")).toEqual({ email: "ann@example.com", password: "pw" });
});

test("resending waits out the cooldown the screen opens with", async () => {
  jest.useFakeTimers();
  try {
    const ui = await render(<VerifyEmail />);
    expect(ui.getByText("Send a new code (30s)")).toBeTruthy();
    // One tick per act: each second's timeout is scheduled by the render the
    // previous one caused.
    for (let i = 0; i < 30; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(ui.getByText("Send a new code")).toBeTruthy();
    await fireEvent.press(ui.getByTestId("verify-resend"));
    expect(sessionMock.account.resendCode).toHaveBeenCalledWith("ann@example.com");
    expect(ui.getByText("A new code is on its way.")).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});
