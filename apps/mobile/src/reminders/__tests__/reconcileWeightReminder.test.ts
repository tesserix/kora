import { reconcileWeightReminder } from "../reconcileWeightReminder";
import * as scheduleModule from "../schedule";

jest.mock("../prefs", () => ({ loadPrefs: jest.fn().mockResolvedValue({}) }));
jest.mock("../customPrefs", () => ({ loadCustom: jest.fn().mockResolvedValue([]) }));
jest.mock("../weightPrefs", () => ({ loadWeightPref: jest.fn().mockResolvedValue({ enabled: true, hour: 7, minute: 0, days: [1] }) }));

// jest.spyOn on the same method across tests reuses the same underlying mock,
// so its call history accumulates unless explicitly restored — needed here
// because the serialisation test below asserts exact call counts.
afterEach(() => {
  jest.restoreAllMocks();
});

test("reconciling re-applies the whole schedule with the supplied weigh-in date", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(new Date(2026, 7, 17, 6, 40));

  expect(apply).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.objectContaining({ lastWeighedAt: new Date(2026, 7, 17, 6, 40) }),
  );
});

test("a null weigh-in date is passed through, so the reminder fires", async () => {
  const apply = jest.spyOn(scheduleModule, "applyAllReminders").mockResolvedValue(undefined);

  await reconcileWeightReminder(null);

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
