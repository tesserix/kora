import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import SignIn from "../sign-in";
import { takeCredentials } from "@/auth/flow";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
  (router.push as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
  takeCredentials("");
});

const SUBTITLE = "Sign in to pick up where you left off.";

async function fillAndSubmit(ui: Awaited<ReturnType<typeof render>>, email: string, password: string) {
  await fireEvent.changeText(ui.getByLabelText("Email"), email);
  await fireEvent.changeText(ui.getByLabelText("Password"), password);
  await fireEvent.press(ui.getByTestId("sign-in-submit"));
}

test("shows Kora's own form and every way in, with no hosted page", async () => {
  const ui = await render(<SignIn />);
  expect(ui.getByTestId("brand-mark")).toBeTruthy();
  expect(ui.getByText("Welcome to Kora.")).toBeTruthy();
  expect(ui.getByLabelText("Email")).toBeTruthy();
  expect(ui.getByLabelText("Password")).toBeTruthy();
  expect(ui.getByLabelText("Continue with Apple")).toBeTruthy();
  expect(ui.getByLabelText("Continue with Google")).toBeTruthy();
  expect(ui.getByLabelText("Create account")).toBeTruthy();
});

test("signs in with the typed email and password and goes home", async () => {
  const ui = await render(<SignIn />);
  await fillAndSubmit(ui, " ann@example.com ", "pw");
  expect(sessionMock.signInWithPassword).toHaveBeenCalledWith("ann@example.com", "pw");
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
});

test("an empty form asks for both fields without calling the API", async () => {
  const ui = await render(<SignIn />);
  await fireEvent.press(ui.getByTestId("sign-in-submit"));
  expect(ui.getByText("Enter your email and password.")).toBeTruthy();
  expect(sessionMock.signInWithPassword).not.toHaveBeenCalled();
});

test("a refusal shows kora-api's own wording and stays put", async () => {
  sessionMock.signInWithPassword.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("invalid_credentials", "That email and password don't match."),
  );
  const ui = await render(<SignIn />);
  await fillAndSubmit(ui, "ann@example.com", "nope");
  expect(await ui.findByText("That email and password don't match.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});

test("an unverified email continues on the code screen holding the password", async () => {
  sessionMock.signInWithPassword.mockRejectedValueOnce(new sessionMock.AuthSessionError("email_not_verified", "Check your email."));
  const ui = await render(<SignIn />);
  await fillAndSubmit(ui, "ann@example.com", "pw");
  expect(router.push).toHaveBeenCalledWith({ pathname: "/verify-email", params: { email: "ann@example.com" } });
  // Held in memory for the code screen, never put in the route.
  expect(takeCredentials("ann@example.com")).toEqual({ email: "ann@example.com", password: "pw" });
});

test("an account with an authenticator app continues on the code screen", async () => {
  sessionMock.signInWithPassword.mockRejectedValueOnce(new sessionMock.AuthSessionError("totp_required", "", "ch-1"));
  const ui = await render(<SignIn />);
  await fillAndSubmit(ui, "ann@example.com", "pw");
  expect(router.push).toHaveBeenCalledWith("/two-step");
  expect(router.replace).not.toHaveBeenCalled();
});

test("Apple and Google go to the provider and home", async () => {
  const ui = await render(<SignIn />);
  await fireEvent.press(ui.getByLabelText("Continue with Apple"));
  expect(sessionMock.signInWithProvider).toHaveBeenCalledWith("apple");
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));

  await fireEvent.press(ui.getByLabelText("Continue with Google"));
  expect(sessionMock.signInWithProvider).toHaveBeenCalledWith("google");
});

test("a provider's unverified email is a message, never the code screen", async () => {
  sessionMock.signInWithProvider.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("email_not_verified", "Your account with this provider has no verified email."),
  );
  const ui = await render(<SignIn />);
  await fireEvent.changeText(ui.getByLabelText("Password"), "typed-earlier");
  await fireEvent.press(ui.getByLabelText("Continue with Google"));
  expect(await ui.findByText("Your account with this provider has no verified email.")).toBeTruthy();
  expect(router.push).not.toHaveBeenCalled();
});

test("closing the provider sheet shows nothing and does not navigate", async () => {
  sessionMock.signInWithProvider.mockRejectedValueOnce(new sessionMock.AuthSessionError("cancelled"));
  const ui = await render(<SignIn />);
  await fireEvent.press(ui.getByLabelText("Continue with Apple"));
  expect(router.replace).not.toHaveBeenCalled();
  expect(ui.queryByText(/went wrong/)).toBeNull();
});

test("Create account and Forgot password open Kora's own screens", async () => {
  const ui = await render(<SignIn />);
  await fireEvent.press(ui.getByLabelText("Create account"));
  expect(router.push).toHaveBeenCalledWith("/sign-up");
  await fireEvent.changeText(ui.getByLabelText("Email"), "ann@example.com");
  await fireEvent.press(ui.getByTestId("sign-in-forgot"));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/reset-password", params: { email: "ann@example.com" } });
});

test("a ?reason=expired redirect (forced sign-out after an unrecoverable 401) shows why", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ reason: "expired" });
  const { findByText } = await render(<SignIn />);

  expect(await findByText("Your session expired. Please sign in again.")).toBeTruthy();
});

test("a ?reason=verified redirect prefills the email", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ reason: "verified", email: "ann@example.com" });
  const ui = await render(<SignIn />);
  expect(ui.getByText("Your email is confirmed. Sign in to continue.")).toBeTruthy();
  expect(ui.getByLabelText("Email").props.value).toBe("ann@example.com");
});

// The threshold itself is a device measurement; jest cannot observe platform
// font scaling, so this drives useWindowDimensions directly.
function withFontScale(fontScale: number) {
  // require, not a top-level import: an ESM namespace object is sealed, so
  // jest.spyOn cannot redefine a property on it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require("react-native");
  return jest
    .spyOn(rn, "useWindowDimensions")
    .mockReturnValue({ width: 440, height: 956, scale: 3, fontScale });
}

test("keeps the subtitle at ordinary text sizes", async () => {
  const spy = withFontScale(1);
  try {
    const ui = await render(<SignIn />);
    expect(ui.getByText(SUBTITLE)).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});

test("drops the subtitle at accessibility text sizes, keeping the title and the form", async () => {
  const spy = withFontScale(2.643);
  try {
    const ui = await render(<SignIn />);
    expect(ui.queryByText(SUBTITLE)).toBeNull();
    // The headline is NOT capped or shortened — it is the subtitle that goes.
    expect(ui.getByText("Welcome to Kora.")).toBeTruthy();
    expect(ui.getByLabelText("Sign in")).toBeTruthy();
    expect(ui.getByLabelText("Create account")).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});
