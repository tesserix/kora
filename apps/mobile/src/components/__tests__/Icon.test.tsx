import { render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";
import { Icon } from "@/components/Icon";

test("renders an SF-Symbol-mapped name via SymbolView", async () => {
  await render(<Icon name="house" size={20} color="#000" />);
  expect(screen.getByTestId("sf-house.fill")).toBeTruthy();
});

test("sparkles resolves to a real symbol rather than the Circle fallback", async () => {
  // The brand lockup renders this. An unmapped name falls through to lucide's
  // Circle and renders no `sf-` testID at all, so the mark would ship as a grey
  // dot with nothing failing.
  await render(<Icon name="sparkles" size={22} color="#000" />);
  expect(screen.getByTestId("sf-sparkles")).toBeTruthy();
});

test("sparkles also resolves on Android, where the lucide map is the only source", async () => {
  // The SF-Symbol entry covers iOS only. Without a lucide entry too, Android
  // renders the Circle fallback — and no iOS-path assertion can see that.
  // Compared against a deliberately unmapped name rather than a fixed snapshot,
  // so this stays true if the Circle fallback is ever swapped out.
  const orig = Platform.OS;
  Object.defineProperty(Platform, "OS", { get: () => "android", configurable: true });
  try {
    const sparkles = await render(<Icon name="sparkles" size={22} color="#000" />);
    const fallback = await render(<Icon name="not-a-real-icon" size={22} color="#000" />);
    expect(JSON.stringify(sparkles.toJSON())).not.toBe(JSON.stringify(fallback.toJSON()));
  } finally {
    Object.defineProperty(Platform, "OS", { get: () => orig, configurable: true });
  }
});

test("falls back without throwing on an unknown name", async () => {
  const { toJSON } = await render(<Icon name="not-a-real-icon" size={20} color="#000" />);
  expect(toJSON()).toBeTruthy();
});

test("renders a lucide-only name without a SymbolView", async () => {
  await render(<Icon name="leaf" size={20} color="#000" />);
  expect(screen.queryByTestId(/^sf-/)).toBeNull();
});

test("falls through to lucide on non-iOS", async () => {
  const orig = Platform.OS;
  Object.defineProperty(Platform, "OS", { get: () => "android", configurable: true });
  try {
    const { queryByTestId } = await render(<Icon name="house" color="#000" />);
    expect(queryByTestId("sf-house.fill")).toBeNull();
  } finally {
    Object.defineProperty(Platform, "OS", { get: () => orig, configurable: true });
  }
});
