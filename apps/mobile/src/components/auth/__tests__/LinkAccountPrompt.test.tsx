import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LinkAccountPrompt } from "@/components/auth/LinkAccountPrompt";

const mockExistingSignInMethods = jest.fn();
const mockCompleteLinkWithPassword = jest.fn(async (..._a: unknown[]) => {});
const mockCompleteLinkWithGoogle = jest.fn(async (..._a: unknown[]) => {});
const mockCompleteLinkWithApple = jest.fn(async (..._a: unknown[]) => {});
jest.mock("@/auth/link", () => ({
  existingSignInMethods: (...a: unknown[]) => mockExistingSignInMethods(...a),
  completeLinkWithPassword: (...a: unknown[]) => mockCompleteLinkWithPassword(...a),
  completeLinkWithGoogle: (...a: unknown[]) => mockCompleteLinkWithGoogle(...a),
  completeLinkWithApple: (...a: unknown[]) => mockCompleteLinkWithApple(...a),
}));
const mockSignInWithAppleNative = jest.fn(async (..._a: unknown[]) => ({
  idToken: "a",
  rawNonce: "n",
  fullName: null,
  authorizationCode: "auth-code-xyz" as string | null,
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(async () => "g-token"),
  signInWithAppleNative: (...a: unknown[]) => mockSignInWithAppleNative(...a),
}));
const mockStoreAppleAuthorization = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("@/api/hooks", () => ({
  storeAppleAuthorization: (...a: unknown[]) => mockStoreAppleAuthorization(...a),
}));

const pending = { provider: "apple.com" } as never;

// This project's installed @testing-library/react-native (v14) has an async
// `render()` (see AddFriendSheet.test.tsx et al., which all `await render(...)`).
// renderPrompt awaits it here so every call site below just awaits renderPrompt.
async function renderPrompt(overrides: Record<string, unknown> = {}) {
  const onLinked = jest.fn();
  const onCancel = jest.fn();
  const utils = await render(
    <LinkAccountPrompt
      visible
      email="sam@example.com"
      provider="apple.com"
      pendingCredential={pending}
      onCancel={onCancel}
      onLinked={onLinked}
      {...overrides}
    />,
  );
  return { ...utils, onLinked, onCancel };
}

// `jest.clearAllMocks()` clears recorded calls but does NOT remove
// implementations, so every mock a later test overrides must be restored here
// or the override leaks forward. `mockCompleteLinkWith*` are made to reject by
// the failure tests.
beforeEach(() => {
  jest.clearAllMocks();
  mockExistingSignInMethods.mockResolvedValue(["password"]);
  mockCompleteLinkWithPassword.mockImplementation(async () => {});
  mockCompleteLinkWithGoogle.mockImplementation(async () => {});
  mockCompleteLinkWithApple.mockImplementation(async () => {});
  mockStoreAppleAuthorization.mockResolvedValue({});
  mockSignInWithAppleNative.mockResolvedValue({
    idToken: "a",
    rawNonce: "n",
    fullName: null,
    authorizationCode: "auth-code-xyz",
  });
});

describe("LinkAccountPrompt", () => {
  it("names the account being linked", async () => {
    const { findByText } = await renderPrompt();
    expect(await findByText(/sam@example.com/)).toBeTruthy();
  });

  it("offers only the password control when that is the registered method", async () => {
    const { findByLabelText, queryByLabelText } = await renderPrompt();
    expect(await findByLabelText("Sign in and link")).toBeTruthy();
    expect(queryByLabelText("Continue with Google to link")).toBeNull();
  });

  // Enumeration protection makes the lookup return []. Failing CLOSED here would
  // leave the sheet with nothing but Cancel — an unrecoverable dead end.
  it("fails open and offers every other method when the lookup returns nothing", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { findByLabelText } = await renderPrompt();
    expect(await findByLabelText("Sign in and link")).toBeTruthy();
    expect(await findByLabelText("Continue with Google to link")).toBeTruthy();
  });

  it("never offers the provider currently being linked as its own re-auth method", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { queryByLabelText, findByLabelText } = await renderPrompt({ provider: "google.com" });
    await findByLabelText("Sign in and link");
    expect(queryByLabelText("Continue with Google to link")).toBeNull();
  });

  it("links with the pending credential and reports success", async () => {
    const { findByLabelText, getByLabelText, onLinked } = await renderPrompt();
    fireEvent.changeText(getByLabelText("Password"), "hunter2");
    const signInButton = await findByLabelText("Sign in and link");
    await act(async () => {
      fireEvent.press(signInButton);
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mockCompleteLinkWithPassword).toHaveBeenCalledWith("sam@example.com", "hunter2", pending);
  });

  it("shows mapped copy on failure and does not report success", async () => {
    mockCompleteLinkWithPassword.mockRejectedValue({ code: "auth/reauth-failed" });
    const { findByLabelText, findByText, onLinked } = await renderPrompt();
    const signInButton = await findByLabelText("Sign in and link");
    await act(async () => {
      fireEvent.press(signInButton);
    });
    expect(await findByText("That password is incorrect.")).toBeTruthy();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("never leaks a raw SDK message", async () => {
    mockCompleteLinkWithPassword.mockRejectedValue({
      code: "auth/unknown",
      message: "/Users/x/Native.swift:42 boom",
    });
    const { findByLabelText, queryByText, findByText } = await renderPrompt();
    const signInButton = await findByLabelText("Sign in and link");
    await act(async () => {
      fireEvent.press(signInButton);
    });
    await findByText("Something went wrong. Please try again.");
    expect(queryByText(/Native.swift/)).toBeNull();
  });

  // Absence assertion made meaningful: an error is on screen FIRST, so a
  // component that never clears errors fails here.
  it("clears the error when a cancelled sign-in follows a failure", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    mockCompleteLinkWithPassword.mockRejectedValue({ code: "auth/reauth-failed" });
    const { findByLabelText, findByText, queryByText } = await renderPrompt();
    const signInButton = await findByLabelText("Sign in and link");
    await act(async () => {
      fireEvent.press(signInButton);
    });
    expect(await findByText("That password is incorrect.")).toBeTruthy();

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockCompleteLinkWithGoogle.mockRejectedValue(new AuthCancelledError());
    const googleButton = await findByLabelText("Continue with Google to link");
    await act(async () => {
      fireEvent.press(googleButton);
    });
    await waitFor(() => expect(queryByText("That password is incorrect.")).toBeNull());
  });

  // Finding 3: the Apple link path fetches a FRESH authorizationCode from
  // signInWithAppleNative and must forward it, or the user linking to a
  // password/Google account this way never gets a token captured.
  it("captures the Apple authorization code obtained while linking", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    const { findByLabelText, onLinked } = await renderPrompt({ provider: "google.com" });
    const appleButton = await findByLabelText("Continue with Apple to link");
    await act(async () => {
      fireEvent.press(appleButton);
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mockCompleteLinkWithApple).toHaveBeenCalled();
    expect(mockStoreAppleAuthorization).toHaveBeenCalledWith("auth-code-xyz");
  });

  it("still reports success when the authorization capture fails", async () => {
    mockExistingSignInMethods.mockResolvedValue([]);
    mockStoreAppleAuthorization.mockRejectedValue(new Error("offline"));
    const { findByLabelText, onLinked } = await renderPrompt({ provider: "google.com" });
    const appleButton = await findByLabelText("Continue with Apple to link");
    await act(async () => {
      fireEvent.press(appleButton);
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
  });
});
