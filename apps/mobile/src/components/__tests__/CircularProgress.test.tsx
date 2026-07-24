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

function circumferenceOf(strokeDasharray: number | number[]): number {
  return Array.isArray(strokeDasharray) ? strokeDasharray[0] : strokeDasharray;
}

test("clamps the arc to empty when max is zero", async () => {
  const { getByTestId } = await render(<CircularProgress value={5} max={0} />);
  const arc = getByTestId("cp-arc");
  expect(arc.props.strokeDashoffset).toBe(circumferenceOf(arc.props.strokeDasharray));
});

test("partially fills the arc for a real value", async () => {
  const { getByTestId } = await render(<CircularProgress value={50} max={100} />);
  const arc = getByTestId("cp-arc");
  expect(arc.props.strokeDashoffset).toBeLessThan(circumferenceOf(arc.props.strokeDasharray));
});
