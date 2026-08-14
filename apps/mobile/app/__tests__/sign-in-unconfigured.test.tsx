import { render } from "@testing-library/react-native";

import SignIn from "../sign-in";

// The configured case lives in sign-in.test.tsx. jest.mock is per-file, so the
// unconfigured branch needs its own file to flip isFirebaseConfigured.
jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
// Same stubs sign-in.test.tsx needs: firebase/auth ships untransformed ESM, and
// the native social modules do not exist under Jest. None of it is exercised
// here — the module just has to load.
jest.mock("firebase/auth", () => ({
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(async () => {}),
}));
jest.mock("@/lib/socialAuth", () => ({
  configureGoogleSignin: jest.fn(),
  signInWithGoogleNative: jest.fn(),
  signInWithAppleNative: jest.fn(),
}));

// #159: SignIn used to early-return null BEFORE calling useTheme,
// useLocalSearchParams, seven useStates and a useEffect — a conditional-hooks
// violation. It never crashed because isFirebaseConfigured is
// `config !== null` at module scope, evaluated once at import, so the hook
// order was stable by accident rather than by construction. The guard now sits
// below the hooks.
//
// This pins the BEHAVIOUR that move must not change: an unconfigured build
// still renders nothing here. (app/_layout.tsx redirects to /config-missing
// before this screen mounts; the guard is belt-and-braces.)
test("renders nothing when Firebase is not configured", async () => {
  const { toJSON } = await render(<SignIn />);
  expect(toJSON()).toBeNull();
});
