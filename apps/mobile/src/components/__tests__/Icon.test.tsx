import { render, screen } from "@testing-library/react-native";
import { Platform } from "react-native";
import { Icon } from "@/components/Icon";

test("renders an SF-Symbol-mapped name via SymbolView", async () => {
  await render(<Icon name="house" size={20} color="#000" />);
  expect(screen.getByTestId("sf-house.fill")).toBeTruthy();
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
