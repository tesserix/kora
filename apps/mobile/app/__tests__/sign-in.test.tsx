import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

const mockSignIn = jest.fn();
const mockCreateUser = jest.fn();

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));
jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: (...args: unknown[]) => mockSignIn(...args),
  createUserWithEmailAndPassword: (...args: unknown[]) => mockCreateUser(...args),
  // sign-in.tsx now transitively imports @/auth/socialCredentials -> @/api/hooks
  // -> src/lib/api.ts, which calls onAuthStateChanged(auth, ...) and imports
  // signOut at module load — both must exist on this mock or the module fails
  // to load, unrelated to anything this suite exercises.
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(async () => {}),
}));
jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { name: "mock-auth" },
}));
// sign-in.tsx now also imports @/lib/socialAuth (native Apple/Google sheets)
// and @/components/auth/LinkAccountPrompt for the social sign-in buttons added
// alongside the email/password path this suite exercises — neither native
// module is available under Jest, so both are stubbed out here.
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(),
  signInWithAppleNative: jest.fn(),
}));
jest.mock("@/components/auth/LinkAccountPrompt", () => ({
  LinkAccountPrompt: () => null,
}));

import SignIn from "../sign-in";

beforeEach(() => {
  mockSignIn.mockClear();
  mockCreateUser.mockClear();
  (router.replace as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

// The footer CTA and the mode toggle both read "Create account" in sign-up mode,
// so the submit button is addressed by testID rather than by text.
const submit = (ui: Awaited<ReturnType<typeof render>>) => ui.getByTestId("auth-submit");

test("Sign-in shows the brand, the editorial title and filled fields", async () => {
  const ui = await render(<SignIn />);
  expect(ui.getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(await ui.findByText("Welcome back.")).toBeTruthy();
  expect(await ui.findByLabelText("Email")).toBeTruthy();
  expect(await ui.findByLabelText("Password")).toBeTruthy();
});

test("successful sign-in calls firebase and navigates home", async () => {
  mockSignIn.mockResolvedValueOnce(undefined);
  const ui = await render(<SignIn />);

  await fireEvent.changeText(ui.getByLabelText("Email"), "person@example.com");
  await fireEvent.changeText(ui.getByLabelText("Password"), "hunter2");
  await fireEvent.press(submit(ui));

  await waitFor(() =>
    expect(mockSignIn).toHaveBeenCalledWith({ name: "mock-auth" }, "person@example.com", "hunter2"),
  );
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  expect(mockCreateUser).not.toHaveBeenCalled();
});

test("switching to create-account mode calls createUserWithEmailAndPassword instead", async () => {
  mockCreateUser.mockResolvedValueOnce(undefined);
  const ui = await render(<SignIn />);

  await fireEvent.press(ui.getByText("Create account"));
  await fireEvent.changeText(ui.getByLabelText("Email"), "new@example.com");
  await fireEvent.changeText(ui.getByLabelText("Password"), "hunter2000");
  await fireEvent.press(submit(ui));

  await waitFor(() =>
    expect(mockCreateUser).toHaveBeenCalledWith({ name: "mock-auth" }, "new@example.com", "hunter2000"),
  );
  expect(mockSignIn).not.toHaveBeenCalled();
});

test("the heading tracks the mode, so a new user is not greeted 'welcome back'", async () => {
  const ui = await render(<SignIn />);
  expect(ui.getByText("Welcome back.")).toBeTruthy();
  await fireEvent.press(ui.getByText("Create account"));
  expect(ui.queryByText("Welcome back.")).toBeNull();
  expect(ui.getByText("Start with Kora.")).toBeTruthy();
});

test("a failed sign-in surfaces a specific message and does not navigate", async () => {
  mockSignIn.mockRejectedValueOnce({ code: "auth/invalid-credential" });
  const ui = await render(<SignIn />);

  await fireEvent.changeText(ui.getByLabelText("Email"), "person@example.com");
  await fireEvent.changeText(ui.getByLabelText("Password"), "wrong");
  await fireEvent.press(submit(ui));

  expect(await ui.findByText("Email or password is incorrect.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});

test("a ?reason=expired redirect (forced sign-out after an unrecoverable 401) shows why", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ reason: "expired" });
  const { findByText } = await render(<SignIn />);

  expect(await findByText("Your session expired. Please sign in again.")).toBeTruthy();
});

test("a weak password reports the real reason, not a generic check-your-password", async () => {
  // The shipped screen told a user whose password was too short to check their
  // password — the one thing that was not the problem.
  mockCreateUser.mockRejectedValueOnce({ code: "auth/weak-password" });
  const ui = await render(<SignIn />);

  await fireEvent.press(ui.getByText("Create account"));
  await fireEvent.press(submit(ui));

  expect(await ui.findByText("Choose a password of at least 6 characters.")).toBeTruthy();
});

test("an already-registered email is reported as such", async () => {
  mockCreateUser.mockRejectedValueOnce({ code: "auth/email-already-in-use" });
  const ui = await render(<SignIn />);

  await fireEvent.press(ui.getByText("Create account"));
  await fireEvent.press(submit(ui));

  expect(await ui.findByText("That email already has an account. Try signing in.")).toBeTruthy();
});

test("switching mode clears a stale error from the previous mode", async () => {
  mockSignIn.mockRejectedValueOnce({ code: "auth/invalid-credential" });
  const ui = await render(<SignIn />);

  await fireEvent.press(submit(ui));
  expect(await ui.findByText("Email or password is incorrect.")).toBeTruthy();

  await fireEvent.press(ui.getByText("Create account"));
  expect(ui.queryByText("Email or password is incorrect.")).toBeNull();
});
