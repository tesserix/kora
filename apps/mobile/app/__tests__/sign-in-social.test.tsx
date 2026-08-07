import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
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
// sign-in.tsx renders LinkAccountPrompt, which imports @/api/hooks for
// storeAppleAuthorization; the real module pulls in @/lib/api, which calls
// firebase/auth's onAuthStateChanged at import time — not stubbed above,
// since this suite mocks firebase/auth minimally for its own needs.
jest.mock("@/api/hooks", () => ({
  storeAppleAuthorization: jest.fn(async (..._a: unknown[]) => ({})),
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
    authorizationCode: "auth-code-xyz",
  })),
}));
jest.mock("expo-apple-authentication", () => {
  const { Pressable } = require("react-native");
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationButton: (props: Record<string, unknown>) => <Pressable {...props} />,
  };
});

const ORIGINAL_GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

beforeEach(() => {
  jest.clearAllMocks();
  mockSignInWithAppleCredential.mockResolvedValue({ status: "signed-in" });
  mockSignInWithGoogleCredential.mockResolvedValue({ status: "signed-in" });
  // Configured by default so the pre-existing tests below (which press the
  // Google button) keep passing; the unconfigured case is its own describe.
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "web-client-id";
});

afterEach(() => {
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = ORIGINAL_GOOGLE_CLIENT_ID;
});

describe("sign-in social providers", () => {
  it("offers both providers", async () => {
    const { getByLabelText } = await render(<SignIn />);
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
    expect(getByLabelText("Sign in with Google")).toBeTruthy();
  });

  it("passes the RAW nonce and token from the native sheet through to Firebase", async () => {
    const { getByLabelText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Apple"));
    });
    await waitFor(() =>
      expect(mockSignInWithAppleCredential).toHaveBeenCalledWith(
        "a-token",
        "raw",
        { givenName: "Ada" },
        "auth-code-xyz",
      ),
    );
  });

  it("navigates to the app on a successful Apple sign-in", async () => {
    const { getByLabelText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Apple"));
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("navigates to the app on a successful Google sign-in", async () => {
    const { getByLabelText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Google"));
    });
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
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Apple"));
    });
    expect(await findByText(/Link your account/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows mapped copy when a provider sign-in fails", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Google"));
    });
    expect(await findByText("Couldn't reach Kora. Check your connection.")).toBeTruthy();
  });

  // Absence made meaningful: an error is on screen first.
  it("shows nothing when the user cancels the native sheet", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText, queryByText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Google"));
    });
    await findByText("Couldn't reach Kora. Check your connection.");

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockSignInWithGoogleCredential.mockRejectedValue(new AuthCancelledError());
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Google"));
    });
    await waitFor(() =>
      expect(queryByText("Couldn't reach Kora. Check your connection.")).toBeNull(),
    );
  });

  // The defect this whole wave exists to fix: auth/invalid-credential is what
  // Firebase throws when a provider isn't enabled yet (this branch's actual
  // pre-configuration state), and the untagged mapping is "Email or password
  // is incorrect." — actively wrong on a screen where no password was typed.
  it("does not blame a password when Apple sign-in is rejected as invalid-credential", async () => {
    mockSignInWithAppleCredential.mockRejectedValue({ code: "auth/invalid-credential" });
    const { getByLabelText, findByText, queryByText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Sign in with Apple"));
    });
    expect(await findByText("Couldn't verify that account. Try again.")).toBeTruthy();
    expect(queryByText("Email or password is incorrect.")).toBeNull();
  });

  describe("when Google is not yet configured", () => {
    beforeEach(() => {
      process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = "";
    });

    it("does not render a Google button that can only fail", async () => {
      const { queryByLabelText, getByLabelText } = await render(<SignIn />);
      expect(queryByLabelText("Sign in with Google")).toBeNull();
      // Apple is unaffected — this is a Google-specific gap.
      expect(getByLabelText("Sign in with Apple")).toBeTruthy();
    });
  });
});

describe("sign-in first paint", () => {
  it("shows both provider buttons and no email fields", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
    expect(getByLabelText("Sign in with Google")).toBeTruthy();
    // The reveal is the behaviour: absent now, present after the tap below.
    expect(queryByLabelText("Email")).toBeNull();
    expect(queryByLabelText("Password")).toBeNull();
  });

  it("reveals the email form in place when 'Use email instead' is pressed", async () => {
    const { getByText, getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();

    await act(async () => {
      fireEvent.press(getByText("Use email instead"));
    });

    expect(getByLabelText("Email")).toBeTruthy();
    expect(getByLabelText("Password")).toBeTruthy();
    expect(getByLabelText("Sign in")).toBeTruthy();
    // The provider buttons stay visible — the form joins them, not replaces them.
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
  });

  it("no longer renders the ambiguous Sign in / Create account segmented control", async () => {
    const { getByLabelText, queryAllByRole } = await render(<SignIn />);
    // Presence first: the screen rendered.
    expect(getByLabelText("Sign in with Google")).toBeTruthy();
    // Segmented renders each option with accessibilityRole="tab"
    // (src/components/Segmented.tsx:61) and carries no testID. Role is the
    // unambiguous discriminator here: the new footer link reuses the strings
    // "Sign in" and "Create an account", so a label-based assertion would be
    // satisfied by the very control that replaced it.
    expect(queryAllByRole("tab")).toHaveLength(0);
  });
});

describe("sign-in mode toggle", () => {
  it("flips heading, CTA and footer link together", async () => {
    const { getByText, queryByText } = await render(<SignIn />);
    expect(getByText("Welcome back.")).toBeTruthy();
    expect(getByText("Create an account")).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByText("Create an account"));
    });

    expect(getByText("Start with Kora.")).toBeTruthy();
    expect(getByText("Sign in")).toBeTruthy();
    expect(queryByText("Welcome back.")).toBeNull();
  });
});
