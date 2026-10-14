import { render } from "@testing-library/react-native";

import SignIn from "../sign-in";
import { sessionMock } from "@/test/sessionMock";

// The configured case lives in sign-in.test.tsx; this file flips the session
// mock's isAuthConfigured before the screen renders.
jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));

beforeEach(() => {
  sessionMock.isAuthConfigured = false;
});

// #159: SignIn used to early-return null BEFORE calling useTheme,
// useLocalSearchParams, seven useStates and a useEffect — a conditional-hooks
// violation. It never crashed because the configured flag was evaluated once
// at import, so the hook
// order was stable by accident rather than by construction. The guard now sits
// below the hooks.
//
// This pins the BEHAVIOUR that move must not change: an unconfigured build
// still renders nothing here. (app/_layout.tsx redirects to /config-missing
// before this screen mounts; the guard is belt-and-braces.)
test("renders nothing when sign-in is not configured", async () => {
  const { toJSON } = await render(<SignIn />);
  expect(toJSON()).toBeNull();
});
