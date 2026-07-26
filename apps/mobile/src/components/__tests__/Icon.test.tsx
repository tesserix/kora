import { render, screen } from "@testing-library/react-native";
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
