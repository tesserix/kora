import { render } from "@testing-library/react-native";
import { Icon } from "@/components/Icon";

test("renders a known icon by mockup kebab name", async () => {
  const { toJSON } = await render(<Icon name="sparkles" size={20} color="#000" />);
  expect(toJSON()).toBeTruthy();
});

test("falls back without throwing on an unknown name", async () => {
  const { toJSON } = await render(<Icon name="not-a-real-icon" size={20} color="#000" />);
  expect(toJSON()).toBeTruthy();
});
