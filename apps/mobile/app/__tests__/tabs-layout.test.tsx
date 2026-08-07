import { render } from "@testing-library/react-native";
import { router } from "expo-router";
import TabsLayout from "../(tabs)/_layout";
import { ApiError } from "@/lib/api";

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  Tabs: Object.assign(
    ({ children }: { children: React.ReactNode }) => {
      const { View } = require("react-native");
      return <View testID="tabs">{children}</View>;
    },
    { Screen: () => null },
  ),
}));
jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("firebase/auth", () => ({ onAuthStateChanged: jest.fn(() => jest.fn()) }));
jest.mock("@/lib/push", () => ({ usePushRegistration: jest.fn(), usePushResponder: jest.fn() }));
jest.mock("@/components/FloatingTabBar", () => ({ FloatingTabBar: () => null }));

const mockUseProfile = jest.fn();
jest.mock("@/api/hooks", () => ({ useProfile: () => mockUseProfile() }));

const LOADING = { data: undefined, isLoading: true, isError: false, error: null, refetch: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

test("renders the branded splash and NOT the tabs while the profile loads", async () => {
  mockUseProfile.mockReturnValue(LOADING);
  const { getByTestId, queryByTestId } = await render(<TabsLayout />);
  expect(getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(queryByTestId("tabs")).toBeNull();
});

test("renders the tabs once an onboarded profile resolves", async () => {
  mockUseProfile.mockReturnValue({
    data: { onboarded_at: "2026-01-01T00:00:00Z" },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  });
  const { getByTestId } = await render(<TabsLayout />);
  expect(getByTestId("tabs")).toBeTruthy();
});

test("routes a never-onboarded profile to onboarding instead of the tabs", async () => {
  mockUseProfile.mockReturnValue({
    data: { onboarded_at: null },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
  });
  const { queryByTestId } = await render(<TabsLayout />);
  expect(router.replace).toHaveBeenCalledWith("/onboarding");
  expect(queryByTestId("tabs")).toBeNull();
});

// The state that currently strands people silently.
test("renders a retry on a non-401 failure, and not the tabs", async () => {
  const refetch = jest.fn();
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(500, "server_error", "boom", "req-1"),
    refetch,
  });
  const { getByLabelText, queryByTestId } = await render(<TabsLayout />);
  expect(getByLabelText("Retry")).toBeTruthy();
  expect(queryByTestId("tabs")).toBeNull();
});

// A 401 means api.ts has already forced a sign-out and a redirect to
// /sign-in?reason=expired is in flight. Retry cannot succeed. The test above
// establishes that Retry DOES render for a non-401 error, so its absence here
// is a disappearance rather than a control that never rendered.
test("a 401 renders the splash, not the retry", async () => {
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(401, "unauthorized", "expired", "req-2"),
    refetch: jest.fn(),
  });
  const { getByTestId, queryByLabelText, queryByTestId } = await render(<TabsLayout />);
  expect(getByTestId("brand-dot-0-0")).toBeTruthy();
  expect(queryByLabelText("Retry")).toBeNull();
  expect(queryByTestId("tabs")).toBeNull();
});

// Consuming the one-shot here would strip `reason=expired` off the sign-in
// screen, turning an explained expiry into an unexplained bounce.
test("does not consume the session-expired notice", async () => {
  const api = require("@/lib/api");
  const spy = jest.spyOn(api, "takeSessionExpiredNotice");
  mockUseProfile.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: true,
    error: new ApiError(401, "unauthorized", "expired", "req-3"),
    refetch: jest.fn(),
  });
  await render(<TabsLayout />);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});
