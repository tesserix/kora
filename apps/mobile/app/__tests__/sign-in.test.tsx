import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import SignIn from "../sign-in";

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
  expect(ui.getByTestId("brand-mark")).toBeTruthy();
  expect(await ui.findByText("Welcome back.")).toBeTruthy();
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue with email"));
  });
  expect(await ui.findByLabelText("Email")).toBeTruthy();
  expect(await ui.findByLabelText("Password")).toBeTruthy();
});

test("successful sign-in calls firebase and navigates home", async () => {
  mockSignIn.mockResolvedValueOnce(undefined);
  const ui = await render(<SignIn />);

  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue with email"));
  });
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

  await act(async () => {
    fireEvent.press(ui.getByText("Create an account"));
  });
  // The footer link reveals the email form itself; this guards the setup
  // step so the test still works if that changes.
  if (ui.queryByLabelText("Continue with email")) {
    await act(async () => {
      fireEvent.press(ui.getByLabelText("Continue with email"));
    });
  }
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
  await act(async () => {
    fireEvent.press(ui.getByText("Create an account"));
  });
  expect(ui.queryByText("Welcome back.")).toBeNull();
  expect(ui.getByText("Start with Kora.")).toBeTruthy();
});

test("a failed sign-in surfaces a specific message and does not navigate", async () => {
  mockSignIn.mockRejectedValueOnce({ code: "auth/invalid-credential" });
  const ui = await render(<SignIn />);

  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue with email"));
  });
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

  await act(async () => {
    fireEvent.press(ui.getByText("Create an account"));
  });
  // The footer link reveals the email form itself; this guards the setup
  // step so the test still works if that changes.
  if (ui.queryByLabelText("Continue with email")) {
    await act(async () => {
      fireEvent.press(ui.getByLabelText("Continue with email"));
    });
  }
  await fireEvent.press(submit(ui));

  expect(await ui.findByText("Choose a password of at least 6 characters.")).toBeTruthy();
});

test("an already-registered email is reported as such", async () => {
  mockCreateUser.mockRejectedValueOnce({ code: "auth/email-already-in-use" });
  const ui = await render(<SignIn />);

  await act(async () => {
    fireEvent.press(ui.getByText("Create an account"));
  });
  // The footer link reveals the email form itself; this guards the setup
  // step so the test still works if that changes.
  if (ui.queryByLabelText("Continue with email")) {
    await act(async () => {
      fireEvent.press(ui.getByLabelText("Continue with email"));
    });
  }
  await fireEvent.press(submit(ui));

  expect(await ui.findByText("That email already has an account. Try signing in.")).toBeTruthy();
});

test("switching mode clears a stale error from the previous mode", async () => {
  mockSignIn.mockRejectedValueOnce({ code: "auth/invalid-credential" });
  const ui = await render(<SignIn />);

  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue with email"));
  });
  await fireEvent.press(submit(ui));
  expect(await ui.findByText("Email or password is incorrect.")).toBeTruthy();

  await act(async () => {
    fireEvent.press(ui.getByText("Create an account"));
  });
  expect(ui.queryByText("Email or password is incorrect.")).toBeNull();
});

// kora#173. At accessibility text sizes only Apple and Google were visible on
// first paint; "Continue with email" needed a scroll on the one screen a user
// reaches when they cannot get in. The fix spends the hero's decorative height
// instead of capping its type, so these two pin WHAT gives way and WHAT does
// not — a future tidy-up that caps the title, or that drops the lockup, would
// be a different (worse) trade than the one that was measured.
//
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
    expect(ui.getByText("Sign in to pick up where you left off.")).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});

test("drops the subtitle at accessibility text sizes, keeping title and lockup", async () => {
  const spy = withFontScale(2.643);
  try {
    const ui = await render(<SignIn />);
    expect(ui.queryByText("Sign in to pick up where you left off.")).toBeNull();
    // The headline is NOT capped or shortened — it is the subtitle that goes.
    expect(ui.getByText("Welcome back.")).toBeTruthy();
    // And all three ways in are still on the screen.
    expect(ui.getByLabelText("Continue with Apple")).toBeTruthy();
    expect(ui.getByLabelText("Continue with email")).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});
