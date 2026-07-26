import { relativeTime } from "../relativeTime";

test("formats seconds-old timestamps as now", () => {
  expect(relativeTime(new Date(Date.now() - 5_000).toISOString())).toBe("now");
});

test("formats minutes ago", () => {
  expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
});

test("formats hours ago", () => {
  expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h ago");
});

test("formats days ago", () => {
  expect(relativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d ago");
});

test("formats weeks ago", () => {
  expect(relativeTime(new Date(Date.now() - 10 * 86_400_000).toISOString())).toBe("1w ago");
});
