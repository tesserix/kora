import { localDateNow } from "@/lib/localDate";

// "en-CA" is what yields YYYY-MM-DD, and matches app/(tabs)/diary.tsx and
// src/offline/useQueuedLogs.ts — so a queued row and its server row agree by
// construction rather than by coincidence. A different locale would silently
// send DD/MM/YYYY and every write would be rejected as malformed by the
// server's localday.Resolve.
test("localDateNow returns an ISO calendar date", () => {
  expect(localDateNow()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("localDateNow reads the device zone, not UTC", () => {
  const spy = jest
    .spyOn(Date.prototype, "toLocaleDateString")
    .mockReturnValue("2026-02-28");
  expect(localDateNow()).toBe("2026-02-28");
  expect(spy).toHaveBeenCalledWith("en-CA");
  spy.mockRestore();
});

// The date must come from the moment of capture, not from module load — a
// session open across midnight would otherwise keep filing logs on yesterday.
test("localDateNow is evaluated per call", () => {
  const spy = jest.spyOn(Date.prototype, "toLocaleDateString");
  spy.mockReturnValueOnce("2026-02-28").mockReturnValueOnce("2026-03-01");
  expect(localDateNow()).toBe("2026-02-28");
  expect(localDateNow()).toBe("2026-03-01");
  spy.mockRestore();
});
