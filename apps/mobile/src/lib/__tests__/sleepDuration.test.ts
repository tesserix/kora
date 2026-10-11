import { sleepDurationLabel } from "../sleepDuration";

describe("sleepDurationLabel", () => {
  // The case that prompted it: the Health app says "4h 26m" and Kora said
  // "4.4h". Both were correct; only one was comparable at a glance.
  it("reads the way the Health app reads", () => {
    expect(sleepDurationLabel(4 + 26 / 60)).toBe("4h 26m");
  });

  it("drops the minutes when there are none, rather than saying 0m", () => {
    expect(sleepDurationLabel(7)).toBe("7h");
  });

  it("keeps the hour when minutes round up to a full one", () => {
    // 6h 59.7m must not render as "6h 60m".
    expect(sleepDurationLabel(6 + 59.7 / 60)).toBe("7h");
  });

  it("shows minutes alone for a night under an hour", () => {
    expect(sleepDurationLabel(0.75)).toBe("45m");
  });

  // A zero-length merge is a real measurement, not an absence — absence is
  // `sleep: null` and never reaches this function.
  it("renders a measured zero as zero minutes, not as nothing", () => {
    expect(sleepDurationLabel(0)).toBe("0m");
  });

  it("rounds to the nearest minute rather than truncating", () => {
    expect(sleepDurationLabel(1 + 30.6 / 60)).toBe("1h 31m");
  });
});
