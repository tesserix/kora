import { reconcileWeightReminder } from "../reconcileWeightReminder";
import { fetchLatestWeighInDate } from "../lastWeighIn";
import * as scheduleModule from "../schedule";
import { resolveAuthState } from "@/lib/authState";

jest.mock("../prefs", () => ({ loadPrefs: jest.fn().mockResolvedValue({}) }));
jest.mock("../customPrefs", () => ({ loadCustom: jest.fn().mockResolvedValue([]) }));
jest.mock("../weightPrefs", () => ({ loadWeightPref: jest.fn().mockResolvedValue({ enabled: true, hour: 7, minute: 0, days: [1] }) }));
jest.mock("../lastWeighIn", () => ({ fetchLatestWeighInDate: jest.fn() }));
// The auth gate (#171). Reminders must only be (re-)armed for a signed-in user;
// every test that is not about the gate itself declares the signed-in case.
jest.mock("@/lib/authState", () => ({ resolveAuthState: jest.fn(async () => "signed-in") }));

const mockFetch = fetchLatestWeighInDate as jest.Mock;
const mockAuthState = resolveAuthState as jest.Mock;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(null);
  mockAuthState.mockReset();
  mockAuthState.mockResolvedValue("signed-in");
});

// jest.spyOn on the same method across tests reuses the same underlying mock,
// so its call history accumulates unless explicitly restored — needed here
// because the serialisation test below asserts exact call counts.
afterEach(() => {
  jest.restoreAllMocks();
});

test("a caller-witnessed weigh-in is used as-is, without a redundant fetch", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(new Date(2026, 7, 17, 6, 40));

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: new Date(2026, 7, 17, 6, 40) }),
  );
  expect(mockFetch).not.toHaveBeenCalled();
});

// The core of the feature. Callers that are editing the SCHEDULE (the settings
// section, the launch pass, the foreground listener) do not know whether the
// user weighed in today. They used to pass `null` — indistinguishable from
// "never weighed in" — which re-armed a reminder for a day already logged.
test("a caller that witnessed no weigh-in gets the real date looked up, not a null placeholder", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  const alreadyWeighed = new Date(2026, 7, 17, 6, 40);
  mockFetch.mockResolvedValue(alreadyWeighed);

  await reconcileWeightReminder();

  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: alreadyWeighed }),
  );
});

// Invariant: ignorance must never suppress the reminder. fetchLatestWeighInDate
// resolves to null when the network fails, and that null must reach the
// scheduler so the reminder still FIRES.
test("a failed lookup resolves to null, so the reminder still fires", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  mockFetch.mockResolvedValue(null);

  await expect(reconcileWeightReminder()).resolves.toBeUndefined();

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: null }),
  );
});

// Regression: applyAllReminders starts by cancelling every pending
// notification, so two overlapping reconciles racing that call can interleave
// — a second call's cancel wiping out reminders the first is mid-way through
// rescheduling. A rapid foreground/background/foreground cycle can fire two
// reconciles in quick succession, so this asserts the second call never
// enters applyAllReminders until the first has fully resolved, AND that the
// second (newer) call's lastWeighedAt is the one actually used — coalescing
// must not silently keep the stale first value.
test("two overlapping reconciles are serialised, not interleaved, and the newer lastWeighedAt wins", async () => {
  let resolveFirstRun: () => void = () => {};
  const firstRunGate = new Promise<void>((resolve) => {
    resolveFirstRun = resolve;
  });
  let concurrentEntries = 0;
  let maxConcurrentEntries = 0;
  let callCount = 0;
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockImplementation(async () => {
    callCount++;
    concurrentEntries++;
    maxConcurrentEntries = Math.max(maxConcurrentEntries, concurrentEntries);
    if (callCount === 1) await firstRunGate;
    concurrentEntries--;
  });

  const firstDate = new Date(2026, 7, 17, 6, 40);
  const secondDate = new Date(2026, 7, 18, 6, 40);
  const p1 = reconcileWeightReminder(firstDate);

  // Wait until call 1 has actually entered applyAllReminders (and is now
  // blocked on the gate) before firing call 2 — this exercises "call 2
  // arrives while call 1 is RUNNING", the scenario the fix targets, not
  // "arrives while call 1 is merely queued ahead of any execution" (which
  // coalesces trivially since nothing has run yet).
  while (callCount === 0) {
    await Promise.resolve();
  }

  const p2 = reconcileWeightReminder(secondDate);

  // Flush pending microtasks so call 2's queuing has run, without letting the
  // (still-gated) first run finish.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  // The second call must not have entered applyAllReminders yet — it is
  // queued behind the first, not running alongside it.
  expect(apply).toHaveBeenCalledTimes(1);
  expect(maxConcurrentEntries).toBe(1);

  resolveFirstRun();
  await p1;
  await p2;

  expect(apply).toHaveBeenCalledTimes(2);
  expect(maxConcurrentEntries).toBe(1);
  expect(apply.mock.calls[1]).toEqual([
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: secondDate }),
  ]);
});

// Coalescing must be biased towards knowledge, not recency. A weigh-in that a
// caller actually witnessed is a fact; a no-argument call is an absence of
// information. Plain "newest wins" would let the ignorant call queued behind
// the weigh-in discard it, re-arming the reminder for the day just logged.
test("an explicit weigh-in wins over a no-argument call coalesced behind it", async () => {
  let releaseFirstRun: () => void = () => {};
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  let callCount = 0;
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockImplementation(async () => {
    callCount++;
    if (callCount === 1) await firstRunGate;
  });

  const justWeighed = new Date(2026, 7, 17, 6, 40);

  // Run 1 starts immediately and blocks on the gate.
  const p1 = reconcileWeightReminder();
  while (callCount === 0) await Promise.resolve();

  // Run 2's slot: the weigh-in arrives first, then an ignorant call (the
  // foreground listener, say) lands on the same slot.
  const p2 = reconcileWeightReminder(justWeighed);
  const p3 = reconcileWeightReminder();

  releaseFirstRun();
  await Promise.all([p1, p2, p3]);

  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[1]).toEqual([
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: justWeighed }),
  ]);
});

// The queued slot must be consumed, not remembered: a weigh-in from a run that
// already happened must not leak into a later, unrelated reconcile.
test("a consumed weigh-in does not leak into the next reconcile", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  const justWeighed = new Date(2026, 7, 17, 6, 40);

  await reconcileWeightReminder(justWeighed);
  mockFetch.mockResolvedValue(null);
  await reconcileWeightReminder();

  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[1]).toEqual([
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: null }),
  ]);
});


// --- the signed-out gate (#171) -------------------------------------------
//
// setupPushHandler() runs at module scope on EVERY launch and funnels into
// here, deliberately so reminders survive reinstalls and permission changes.
// It had no auth check, so a user sitting on the sign-in screen after deleting
// their account re-armed the deleted account's meal reminders on every
// relaunch. Cancelling at deletion alone would not have held.
test("a signed-out launch does NOT re-arm reminders", async () => {
  mockAuthState.mockResolvedValue("signed-out");
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  const cancel = jest.spyOn(scheduleModule, "cancelAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder();

  expect(apply).not.toHaveBeenCalled();
  // It also cleans up: reminders armed before this fix shipped (or by a
  // sign-out path that failed to disarm them) are disarmed on the next launch.
  expect(cancel).toHaveBeenCalledTimes(1);
});

// A signed-out reconcile must not even reach the network. fetchLatestWeighInDate
// goes through apiFetch, which with no session produces a pointless 401.
test("a signed-out launch does not look up the last weigh-in", async () => {
  mockAuthState.mockResolvedValue("signed-out");
  jest.spyOn(scheduleModule, "cancelAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder();

  expect(mockFetch).not.toHaveBeenCalled();
});

// The intent of the existing behaviour is preserved: for a SIGNED-IN user the
// launch pass still re-arms everything, so reminders survive reinstalls and
// permission changes exactly as before.
test("a signed-in launch still re-arms reminders", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  const cancel = jest.spyOn(scheduleModule, "cancelAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder();

  expect(apply).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
});

// A missing Firebase config is not a sign-out. Treating it as one would destroy
// a working user's schedule because of an unrelated configuration problem.
test("an unconfigured build neither arms nor cancels anything", async () => {
  mockAuthState.mockResolvedValue("unconfigured");
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);
  const cancel = jest.spyOn(scheduleModule, "cancelAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder();

  expect(apply).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
});
