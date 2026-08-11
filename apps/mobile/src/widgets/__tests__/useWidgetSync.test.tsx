import { render } from "@testing-library/react-native";

const mockSetSnapshot = jest.fn();
const mockClearSnapshot = jest.fn();
jest.mock("../../../modules/widget-bridge", () => ({
  setSnapshot: (json: string) => mockSetSnapshot(json),
  clearSnapshot: () => mockClearSnapshot(),
}));

let mockDashboard: { data: unknown; isError: boolean } = { data: undefined, isError: false };
jest.mock("@/api/hooks", () => ({
  useDashboard: () => mockDashboard,
}));

let mockHealth = { status: "authorized" };
jest.mock("@/health/useHealth", () => ({
  useHealth: () => mockHealth,
  STEP_GOAL: 10000,
}));

// Mirrors src/lib/push.ts's usePushRegistration: the widget sync subscribes to
// auth state rather than reading it, because a sign-out must clear the snapshot
// even though nothing re-renders this hook.
let authCallback: ((user: { uid: string } | null) => void) | null = null;
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: { uid: string } | null) => void) => {
    authCallback = cb;
    return () => {
      authCallback = null;
    };
  },
}));
jest.mock("@/lib/firebase", () => ({ auth: {}, isFirebaseConfigured: true }));

import { useWidgetSync } from "../useWidgetSync";

function Harness() {
  useWidgetSync();
  return null;
}

const summary = {
  date: "2026-08-11",
  consumed: { kcal: 1200, protein_g: 60, carbs_g: 130, fat_g: 40, fiber_g: 12 },
  targets: { kcal: 2451, protein_g: 156, carbs_g: 337, fat_g: 73, fiber_g: 30 },
  water_ml: 0,
  streak_days: 0,
  source_counts: {},
};

beforeEach(() => {
  mockSetSnapshot.mockClear();
  mockClearSnapshot.mockClear();
  mockDashboard = { data: undefined, isError: false };
  mockHealth = { status: "authorized" };
  authCallback = null;
});

test("writes a snapshot once the dashboard resolves", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(1);
  const written = JSON.parse(mockSetSnapshot.mock.calls[0][0]);
  expect(written.kcalConsumed).toBe(1200);
  expect(written.stepGoal).toBe(10000);
  expect(written.healthStatus).toBe("authorized");
});

test("writes nothing while the dashboard has no data", async () => {
  await render(<Harness />);
  expect(mockSetSnapshot).not.toHaveBeenCalled();
});

// A failed refresh must never overwrite a good snapshot with nulls — the
// widget would flip to "Open Kora" while the user's real figures still exist.
test("a failed dashboard fetch leaves the existing snapshot alone", async () => {
  mockDashboard = { data: undefined, isError: true };
  await render(<Harness />);
  expect(mockSetSnapshot).not.toHaveBeenCalled();
  expect(mockClearSnapshot).not.toHaveBeenCalled();
});

// Otherwise the home screen keeps showing the previous user's calories after
// sign-out, visible with no app open to explain it.
test("clears the snapshot when the user signs out", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  expect(authCallback).not.toBeNull();

  authCallback?.(null);
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});

// Signing back IN must not clear — only the transition to null does.
test("does not clear when a user signs in", async () => {
  await render(<Harness />);
  authCallback?.({ uid: "u2" });
  expect(mockClearSnapshot).not.toHaveBeenCalled();
});
