import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
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
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
    expect(getByLabelText("Continue with Google")).toBeTruthy();
  });

  it("passes the RAW nonce and token from the native sheet through to Firebase", async () => {
    const { getByLabelText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Apple"));
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
      fireEvent.press(getByLabelText("Continue with Apple"));
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
  });

  it("navigates to the app on a successful Google sign-in", async () => {
    const { getByLabelText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Google"));
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
      fireEvent.press(getByLabelText("Continue with Apple"));
    });
    expect(await findByText(/Connect Apple/)).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows mapped copy when a provider sign-in fails", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Google"));
    });
    expect(await findByText("Couldn't reach Kora. Check your connection.")).toBeTruthy();
  });

  // Absence made meaningful: an error is on screen first.
  it("shows nothing when the user cancels the native sheet", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText, queryByText } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Google"));
    });
    await findByText("Couldn't reach Kora. Check your connection.");

    const { AuthCancelledError } = jest.requireActual("@/auth/errors");
    mockSignInWithGoogleCredential.mockRejectedValue(new AuthCancelledError());
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Google"));
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
      fireEvent.press(getByLabelText("Continue with Apple"));
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
      expect(queryByLabelText("Continue with Google")).toBeNull();
      // Apple is unaffected — this is a Google-specific gap.
      expect(getByLabelText("Continue with Apple")).toBeTruthy();
    });
  });
});

describe("sign-in first paint", () => {
  it("shows both provider buttons and no email fields", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
    expect(getByLabelText("Continue with Google")).toBeTruthy();
    // The reveal is the behaviour: absent now, present after the tap below.
    expect(queryByLabelText("Email")).toBeNull();
    expect(queryByLabelText("Password")).toBeNull();
  });

  it("reveals the email form in place when 'Continue with email' is pressed", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();

    await act(async () => {
      fireEvent.press(getByLabelText("Continue with email"));
    });

    expect(getByLabelText("Email")).toBeTruthy();
    expect(getByLabelText("Password")).toBeTruthy();
    expect(getByLabelText("Sign in")).toBeTruthy();
    // The provider buttons stay visible — the form joins them, not replaces them.
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
  });

  it("no longer renders the ambiguous Sign in / Create account segmented control", async () => {
    const { getByLabelText, queryAllByRole } = await render(<SignIn />);
    // Presence first: the screen rendered.
    expect(getByLabelText("Continue with Google")).toBeTruthy();
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

describe("sign-in composition", () => {
  it("offers email as a peer button, not a buried link", async () => {
    const { getByLabelText, queryByText } = await render(<SignIn />);
    expect(getByLabelText("Continue with Apple")).toBeTruthy();
    expect(getByLabelText("Continue with Google")).toBeTruthy();
    expect(getByLabelText("Continue with email")).toBeTruthy();
    // The old text link is gone.
    expect(queryByText("Use email instead")).toBeNull();
  });

  it("reveals the form from the email button", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with email"));
    });
    expect(getByLabelText("Email")).toBeTruthy();
    expect(getByLabelText("Password")).toBeTruthy();
  });

  // The defect: this used to change a heading 400px away and nothing else, so on
  // first paint the tap appeared to do nothing at all.
  it("switching to create-account reveals the form at the touch point", async () => {
    const { getByLabelText, queryByLabelText, getByText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();
    await act(async () => {
      fireEvent.press(getByText("Create an account"));
    });
    expect(getByLabelText("Email")).toBeTruthy();
    expect(getByText("Start with Kora.")).toBeTruthy();
  });

  // The crowding fix is a viewport problem, not a presence problem: the Email
  // field should grab focus (and thus scroll into view) the moment it appears,
  // regardless of which control revealed it. Absence-then-presence proves this
  // is the reveal wiring up autoFocus, not a field that was mounted all along.
  it("autofocuses the Email field when revealed via 'Continue with email'", async () => {
    const { getByLabelText, queryByLabelText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();

    await act(async () => {
      fireEvent.press(getByLabelText("Continue with email"));
    });

    const email = getByLabelText("Email");
    expect(email).toBeTruthy();
    expect(email.props.autoFocus).toBe(true);
  });

  it("autofocuses the Email field when revealed via the 'Create an account' footer link", async () => {
    const { getByLabelText, queryByLabelText, getByText } = await render(<SignIn />);
    expect(queryByLabelText("Email")).toBeNull();

    await act(async () => {
      fireEvent.press(getByText("Create an account"));
    });

    const email = getByLabelText("Email");
    expect(email).toBeTruthy();
    expect(email.props.autoFocus).toBe(true);
  });

  // A social failure belongs under the providers it came from, not beneath
  // the unrelated email button. toJSON() serialises the tree in render order
  // for this single-column layout (no absolute positioning, no reordering),
  // so a depth-first walk collecting the two markers in the order encountered
  // is a reliable stand-in for on-screen vertical order.
  it("shows a social failure above the email button, not below it", async () => {
    mockSignInWithGoogleCredential.mockRejectedValue({ code: "auth/network-request-failed" });
    const { getByLabelText, findByText, toJSON } = await render(<SignIn />);
    await act(async () => {
      fireEvent.press(getByLabelText("Continue with Google"));
    });
    await findByText("Couldn't reach Kora. Check your connection.");

    const order: string[] = [];
    const ERROR_TEXT = "Couldn't reach Kora. Check your connection.";
    function walk(node: unknown): void {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const n = node as { props?: Record<string, unknown>; children?: unknown };
      if (n.props?.accessibilityLabel === "Continue with email") order.push("email-button");
      if (Array.isArray(n.children) && n.children.includes(ERROR_TEXT)) order.push("error");
      walk(n.children);
    }
    walk(toJSON());

    expect(order).toEqual(["error", "email-button"]);
  });

  // AppleSignInButton is height: 48, GoogleSignInButton is minHeight: 48; the
  // email button reuses the shared Button component (minHeight: 50), so
  // without an override it stands 2pt taller than its peers.
  it("matches the height of its peer provider buttons", async () => {
    const { getByLabelText } = await render(<SignIn />);
    // Button.tsx wraps PressableScale, which nests the caller's style array
    // inside its own ([style, animated]) — StyleSheet.flatten resolves that
    // nesting where a single Object.assign spread would not.
    const style = getByLabelText("Continue with email").props.style;
    const flat = StyleSheet.flatten(style);
    expect(flat.minHeight).toBe(48);
  });
});
