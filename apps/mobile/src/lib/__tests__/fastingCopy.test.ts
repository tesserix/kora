import { fastElapsedLabel } from "../fastingCopy";

test("reads minutes only under an hour", () => {
  const startedAt = new Date(Date.now() - 45 * 60_000).toISOString();
  expect(fastElapsedLabel(startedAt)).toBe("45m");
});

test("reads hours and minutes at exactly an hour", () => {
  const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  expect(fastElapsedLabel(startedAt)).toBe("1h 0m");
});

test("caps at 48h for a fast left running past the server's cap", () => {
  const startedAt = new Date(Date.now() - 60 * 3600_000).toISOString(); // 60h ago
  expect(fastElapsedLabel(startedAt)).toBe("48h 0m");
});
