import { render } from "@testing-library/react-native";
import { AppText } from "@/components/Text";
import { CircularProgress } from "@/components/CircularProgress";

test("renders centered children over the ring", async () => {
  const { findByText } = await render(
    <CircularProgress value={63} max={100} size={54} stroke={6}>
      <AppText>63%</AppText>
    </CircularProgress>,
  );
  expect(await findByText("63%")).toBeTruthy();
});

test("does not throw when max is zero", async () => {
  await expect(render(<CircularProgress value={5} max={0} />)).resolves.toBeDefined();
});
