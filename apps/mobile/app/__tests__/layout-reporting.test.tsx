// Verifies the module-scope crash-reporting wiring in app/_layout.tsx actually
// installs without throwing, and that the ErrorUtils global handler chains to
// whatever handler was already installed rather than replacing it (replacing
// it outright would silence RedBox in development). Every other piece of this
// task has a test that fails when its wiring is removed; this file covers the
// three highest-blast-radius module-scope edits, which otherwise have none.

const mockReportError = jest.fn();
jest.mock("@/observability/reporter", () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
  initReporting: jest.fn(),
  setReportingUser: jest.fn(),
}));

jest.mock("@/observability/crashlytics", () => ({
  createCrashlyticsSink: jest.fn(() => null),
}));

jest.mock("expo-router", () => ({
  router: { replace: jest.fn() },
  Stack: Object.assign(() => null, { Screen: () => null }),
}));

jest.mock("@/lib/firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(() => jest.fn()),
  signOut: jest.fn(),
}));

const mockPreviousHandler = jest.fn();

beforeEach(() => {
  jest.resetModules();
  mockReportError.mockClear();
  mockPreviousHandler.mockClear();
  // Install a "previous" handler before the module loads, mirroring whatever
  // React Native's default dev-mode handler (RedBox) would already be in
  // place at real startup.
  ErrorUtils.setGlobalHandler(mockPreviousHandler);
});

test("importing the root layout module does not throw", () => {
  expect(() => require("../_layout")).not.toThrow();
});

test("the installed global handler reports the error and still calls the previous handler", () => {
  require("../_layout");

  const installedHandler = ErrorUtils.getGlobalHandler();
  expect(installedHandler).not.toBe(mockPreviousHandler);

  const error = new Error("boom");
  installedHandler(error, true);

  expect(mockReportError).toHaveBeenCalledWith(error);
  expect(mockPreviousHandler).toHaveBeenCalledWith(error, true);
});
