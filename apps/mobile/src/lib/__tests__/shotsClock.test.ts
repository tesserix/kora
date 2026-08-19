// The pinned clock's whole value is that it is inert in production, so that is
// what these assert hardest. Each case re-imports the module because the pin is
// resolved once at module load, deliberately (see src/lib/shotsClock.ts).

const PIN = "2026-08-19T09:41:00";

function loadWith(env: string | undefined, dev: boolean) {
  jest.resetModules();
  const prevDev = (globalThis as { __DEV__?: boolean }).__DEV__;
  const prevEnv = process.env.EXPO_PUBLIC_SHOTS_CLOCK;
  (globalThis as { __DEV__?: boolean }).__DEV__ = dev;
  if (env === undefined) delete process.env.EXPO_PUBLIC_SHOTS_CLOCK;
  else process.env.EXPO_PUBLIC_SHOTS_CLOCK = env;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../shotsClock") as typeof import("../shotsClock");
  } finally {
    (globalThis as { __DEV__?: boolean }).__DEV__ = prevDev;
    if (prevEnv === undefined) delete process.env.EXPO_PUBLIC_SHOTS_CLOCK;
    else process.env.EXPO_PUBLIC_SHOTS_CLOCK = prevEnv;
  }
}

describe("shotsClock", () => {
  it("is the real clock when nothing is pinned", () => {
    const clock = loadWith(undefined, true);
    expect(clock.isClockPinned()).toBe(false);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("returns the pinned instant, repeatably, when pinned in a dev build", () => {
    const clock = loadWith(PIN, true);
    expect(clock.isClockPinned()).toBe(true);
    expect(clock.now().toISOString()).toBe(clock.now().toISOString());
    expect(clock.now().getHours()).toBe(9);
    expect(clock.todayLocalDate()).toBe("2026-08-19");
  });

  // The barrier that matters. A release bundle has __DEV__ === false, so even
  // an EXPO_PUBLIC_SHOTS_CLOCK that somehow reached the build environment
  // cannot move the clock a millisecond.
  it("ignores the pin entirely when __DEV__ is false", () => {
    const clock = loadWith(PIN, false);
    expect(clock.isClockPinned()).toBe(false);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("throws on an unparseable pin rather than silently using the real clock", () => {
    expect(() => loadWith("not-a-date", true)).toThrow(/EXPO_PUBLIC_SHOTS_CLOCK/);
  });

  it("treats an empty pin as absent", () => {
    expect(loadWith("", true).isClockPinned()).toBe(false);
  });
});
