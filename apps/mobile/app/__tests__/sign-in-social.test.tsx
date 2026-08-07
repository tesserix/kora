import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { router } from "expo-router";
import SignIn from "../sign-in";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));
jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: jest.fn(async () => ({})),
  createUserWithEmailAndPassword: jest.fn(async () => ({})),
}));

const mockSignInWithAppleCredential = jest.fn();
const mockSignInWithGoogleCredential = jest.fn();
jest.mock("@/auth/socialCredentials", () => ({
  signInWithAppleCredential: (...a: unknown[]) => mockSignInWithAppleCredential(...a),
  signInWithGoogleCredential: (...a: unknown[]) => mockSignInWithGoogleCredential(...a),
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(async () => "g-token"),
  signInWithAppleNative: jest.fn(async () => ({
    idToken: "a-token",
    rawNonce: "raw",
    fullName: { givenName: "Ada" },
  })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithAppleCredential.mockResolvedValue({ status: "signed-in" });
  mockSignInWithGoogleCredential.mockResolvedValue({ status: "signed-in" });
});

describe("sign-in social providers", () => {
  it("offers both providers", async () => {
    const { getByLabelText } = await render(<SignIn />);
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
    expect(getByLabelText("Continue with Google")).toBeTruthy();
  });

  it("passes the RAW nonce and token from the native sheet through to Firebase", async () => {
    const { getByLabelText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    await waitFor(() =>
      expect(mockSignInWithAppleCredential).toHaveBeenCalledWith("a-token", "raw", {
        givenName: "Ada",
      }),
    );
  });

  it("navigates to the app on a successful Apple sign-in", async () => {
    const { getByLabelText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("navigates to the app on a successful Google sign-in", async () => {
    const { getByLabelText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    await waitFor(() => expect(mockSignInWithGoogleCredential).toHaveBeenCalledWith("g-token"));
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("opens the link prompt on a conflict instead of navigating", async () => {
    mockSignInWithAppleCredential.mockResolvedValue({
      status: "needs-link",
      email: "sam@example.com",
      provider: "apple.com",
      pendingCredential: {},
    });
    const { getByLabelText, findByText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Apple"));
    expect(await findByText(/Link your account/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows mapped copy when a provider sign-in fails", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    expect(await findByText("Couldn't reach Kora. Check your connection.")).toBeTruthy();
  });

  // Absence made meaningful: an error is on screen first.
  it("shows nothing when the user cancels the native sheet", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText, queryByText } = await render(<SignIn />);
    fireEvent.press(getByLabelText("Continue with Google"));
    await findByText("Couldn't reach Kora. Check your connection.");

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockSignInWithGoogleCredential.mockRejectedValue(new AuthCancelledError());
    fireEvent.press(getByLabelText("Continue with Google"));
    await waitFor(() =>
      expect(queryByText("Couldn't reach Kora. Check your connection.")).toBeNull(),
    );
  });
});
