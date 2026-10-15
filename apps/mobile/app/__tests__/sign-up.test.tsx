import { act, fireEvent, render } from "@testing-library/react-native";
import { router } from "expo-router";
import { Linking } from "react-native";

import SignUp from "../sign-up";
import { takeCredentials } from "@/auth/flow";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
}));

const STRONG = "Str0ng!Password";

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
  takeCredentials("");
});

async function submit(ui: Awaited<ReturnType<typeof render>>, name: string, email: string, password: string) {
  await fireEvent.changeText(ui.getByLabelText("Name"), name);
  await fireEvent.changeText(ui.getByLabelText("Email"), email);
  await fireEvent.changeText(ui.getByLabelText("Password"), password);
  await fireEvent.press(ui.getByTestId("sign-up-submit"));
}

test("creates the account and moves to the code screen holding the password", async () => {
  const ui = await render(<SignUp />);
  await submit(ui, "Ann Lee", " ann@example.com ", STRONG);
  expect(sessionMock.account.signUp).toHaveBeenCalledWith("Ann Lee", "ann@example.com", STRONG);
  expect(router.replace).toHaveBeenCalledWith({ pathname: "/verify-email", params: { email: "ann@example.com" } });
  expect(takeCredentials("ann@example.com")).toEqual({ email: "ann@example.com", password: STRONG });
});

test("a password outside the policy is caught before the API", async () => {
  const ui = await render(<SignUp />);
  await submit(ui, "Ann", "ann@example.com", "short");
  expect(ui.getAllByText(/At least 12 characters/).length).toBeGreaterThan(1);
  expect(sessionMock.account.signUp).not.toHaveBeenCalled();
});

test("a taken email shows kora-api's wording and holds nothing", async () => {
  sessionMock.account.signUp.mockRejectedValueOnce(
    new sessionMock.AuthSessionError("email_taken", "An account with this email already exists. Sign in instead."),
  );
  const ui = await render(<SignUp />);
  await submit(ui, "Ann", "ann@example.com", STRONG);
  expect(await ui.findByText("An account with this email already exists. Sign in instead.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  expect(takeCredentials("ann@example.com")).toBeNull();
});

test("offers Apple and Google here too", async () => {
  const ui = await render(<SignUp />);
  await fireEvent.press(ui.getByLabelText("Continue with Google"));
  expect(sessionMock.signInWithProvider).toHaveBeenCalledWith("google");
  expect(router.replace).toHaveBeenCalledWith("/");
});

test("the privacy link opens Kora's own policy, not the general one", async () => {
  const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const ui = await render(<SignUp />);
  await fireEvent.press(ui.getByText("Privacy Policy"));
  expect(open).toHaveBeenCalledWith("https://tesserix.app/privacy/kora");
  open.mockRestore();
});
