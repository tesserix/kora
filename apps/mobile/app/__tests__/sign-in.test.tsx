import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";

import SignIn, { signInMessage } from "../sign-in";
import { sessionMock } from "@/test/sessionMock";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
  (useLocalSearchParams as jest.Mock).mockReturnValue({});
});

const SUBTITLE = "Sign in to pick up where you left off, or create an account to start.";

test("shows the brand, the title and both ways in", async () => {
  const ui = await render(<SignIn />);
  expect(ui.getByTestId("brand-mark")).toBeTruthy();
  expect(ui.getByText("Welcome to Kora.")).toBeTruthy();
  expect(ui.getByLabelText("Continue")).toBeTruthy();
  expect(ui.getByLabelText("Create account")).toBeTruthy();
});

test("Continue runs hosted sign-in and navigates home", async () => {
  const ui = await render(<SignIn />);
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue"));
  });
  expect(sessionMock.signIn).toHaveBeenCalledWith({ register: false });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
});

test("Create account opens hosted registration", async () => {
  const ui = await render(<SignIn />);
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Create account"));
  });
  expect(sessionMock.signIn).toHaveBeenCalledWith({ register: true });
});

test("closing the browser shows nothing and does not navigate", async () => {
  sessionMock.signIn.mockRejectedValueOnce(new sessionMock.AuthSessionError("cancelled"));
  const ui = await render(<SignIn />);
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue"));
  });
  expect(router.replace).not.toHaveBeenCalled();
  expect(ui.queryByText(/went wrong/)).toBeNull();
});

test("a failed round trip surfaces a message and does not navigate", async () => {
  sessionMock.signIn.mockRejectedValueOnce(new sessionMock.AuthSessionError("token_server_error"));
  const ui = await render(<SignIn />);
  await act(async () => {
    fireEvent.press(ui.getByLabelText("Continue"));
  });
  expect(await ui.findByText("Something went wrong signing in. Please try again.")).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
});

test("signInMessage names being offline and stays silent on cancel", () => {
  expect(signInMessage(new TypeError("Network request failed"))).toMatch(/offline/);
  expect(signInMessage(new sessionMock.AuthSessionError("cancelled"))).toBeNull();
});

test("a ?reason=expired redirect (forced sign-out after an unrecoverable 401) shows why", async () => {
  (useLocalSearchParams as jest.Mock).mockReturnValue({ reason: "expired" });
  const { findByText } = await render(<SignIn />);

  expect(await findByText("Your session expired. Please sign in again.")).toBeTruthy();
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

test("drops the subtitle at accessibility text sizes, keeping title and both buttons", async () => {
  const spy = withFontScale(2.643);
  try {
    const ui = await render(<SignIn />);
    expect(ui.queryByText(SUBTITLE)).toBeNull();
    // The headline is NOT capped or shortened — it is the subtitle that goes.
    expect(ui.getByText("Welcome to Kora.")).toBeTruthy();
    expect(ui.getByLabelText("Continue")).toBeTruthy();
    expect(ui.getByLabelText("Create account")).toBeTruthy();
  } finally {
    spy.mockRestore();
  }
});
