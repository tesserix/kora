import { render } from "@testing-library/react-native";

import { useWidgetSync } from "../useWidgetSync";

const mockSetSnapshot = jest.fn();
const mockClearSnapshot = jest.fn();
jest.mock("../../../modules/widget-bridge", () => ({
  setSnapshot: (json: string) => mockSetSnapshot(json),
  clearSnapshot: () => mockClearSnapshot(),
}));

// useDashboard is mocked below (not react-query itself), so there is no real
// QueryClient in this tree for the hook to pull from context — a bare
// useQueryClient() would throw "No QueryClient set". qc.clear is the only
// method under test; mocking useQueryClient directly keeps the assertion on
// that call instead of on cache internals a real client would hide.
const mockQcClear = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: mockQcClear }),
}));

let mockDashboard: { data: unknown; isError: boolean } = { data: undefined, isError: false };
jest.mock("@/api/hooks", () => ({
  useDashboard: () => mockDashboard,
}));

jest.mock("@/health/useHealth", () => ({
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
  mockQcClear.mockClear();
  mockDashboard = { data: undefined, isError: false };
  authCallback = null;
});

test("writes a snapshot once the dashboard resolves", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(1);
  const written = JSON.parse(mockSetSnapshot.mock.calls[0][0]);
  expect(written.kcalConsumed).toBe(1200);
  expect(written.stepGoal).toBe(10000);
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
  // Same-day resurrection guard: useDashboard's key is owner-scoped, but a
  // cached ["dashboard", A, date] entry can still be sitting in the shared
  // QueryClient. Clearing the whole client on sign-out is the defense-in-depth
  // twin of that key fix — belt AND braces, not either/or.
  expect(mockQcClear).toHaveBeenCalledTimes(1);
});

// The first auth event of a fresh mount has nothing prior to compare
// against, and repeat events for the SAME uid (token refresh, etc.) are not
// a user switch — neither should scrub the snapshot.
test("does not clear on the first sign-in or on same-uid re-emissions", async () => {
  await render(<Harness />);
  authCallback?.({ uid: "u1" });
  authCallback?.({ uid: "u1" });
  expect(mockClearSnapshot).not.toHaveBeenCalled();
  expect(mockQcClear).not.toHaveBeenCalled();
});

// A DIFFERENT uid replacing a known previous one is a user switch — user B
// must never see user A's cached calories, even for the moment before B's
// own dashboard fetch resolves.
test("clears when a different uid replaces the previous one", async () => {
  await render(<Harness />);
  authCallback?.({ uid: "u1" });
  expect(mockClearSnapshot).not.toHaveBeenCalled();
  expect(mockQcClear).not.toHaveBeenCalled();
  authCallback?.({ uid: "u2" });
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
  expect(mockQcClear).toHaveBeenCalledTimes(1);
});

// The resurrection case the re-review flagged: useDashboard's react-query
// cache is a SEPARATE store from the native snapshot, on its own 30s
// staleTime. Scoping the dashboard key by owner (src/api/hooks.ts) stops a
// NEW query from ever reading across accounts, but nothing about that key
// change stops a component from synchronously reading an already-cached
// entry for the outgoing user during the same tick a switch is observed.
// qc.clear() removing every entry — not just the one under the previous
// key — is what closes that window; asserting it fires in the same
// transition that clears the snapshot is the regression test for it.
test("clears the query cache (not just the snapshot) on a same-day account switch", async () => {
  mockDashboard = { data: summary, isError: false };
  await render(<Harness />);
  authCallback?.({ uid: "u1" });
  mockQcClear.mockClear();
  mockClearSnapshot.mockClear();

  authCallback?.({ uid: "u2" });
  // Both scrubs fire in the SAME transition, from the SAME condition — the
  // structural (owner-scoped key) and defense-in-depth (whole-client clear)
  // fixes are not alternatives, they run together.
  expect(mockQcClear).toHaveBeenCalledTimes(1);
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});
