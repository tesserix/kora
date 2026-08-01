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
}));
jest.mock("@/lib/firebase", () => ({
  isFirebaseConfigured: true,
  auth: { name: "mock-auth" },
}));

import SignIn from "../sign-in";

beforeEach(() => {
  mockSignIn.mockClear();
  mockCreateUser.mockClear();
  (router.replace as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

test("Sign-in shows the editorial title and filled fields", async () => {
  const { findByText, findByLabelText } = await render(<SignIn />);
  expect(await findByText("Welcome to Kora")).toBeTruthy();
  expect(await findByLabelText("Email")).toBeTruthy();
  expect(await findByLabelText("Password")).toBeTruthy();
});

test("successful sign-in calls firebase and navigates home", async () => {
  mockSignIn.mockResolvedValueOnce(undefined);
  const { getByText, getByLabelText } = await render(<SignIn />);

  await fireEvent.changeText(getByLabelText("Email"), "person@example.com");
  await fireEvent.changeText(getByLabelText("Password"), "hunter2");
  await fireEvent.press(getByText("Sign in"));

  await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith({ name: "mock-auth" }, "person@example.com", "hunter2"));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
});

test("a failed sign-in surfaces the error message and does not navigate", async () => {
  mockSignIn.mockRejectedValueOnce(new Error("bad credentials"));
  const { getByText, getByLabelText, findByText } = await render(<SignIn />);

  await fireEvent.changeText(getByLabelText("Email"), "person@example.com");
  await fireEvent.changeText(getByLabelText("Password"), "wrong");
  await fireEvent.press(getByText("Sign in"));

  expect(await findByText("Sign-in failed. Check your email and password.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});

test("a ?reason=expired redirect (forced sign-out after an unrecoverable 401) shows why", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ reason: "expired" });
  const { findByText } = await render(<SignIn />);

  expect(await findByText("Your session expired. Please sign in again.")).toBeTruthy();
});
